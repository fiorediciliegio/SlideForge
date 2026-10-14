#!/usr/bin/env node
/**
 * Concurrent + self-refreshing uploader for Anna executa binary artifacts.
 *
 * Why this exists: `anna-app executa publish` uploads parts strictly one at a
 * time, and the short-lived upload token (~15 min) can expire before a large
 * artifact set finishes on a slow uplink, producing
 *   `401 UPLOAD_TOKEN_INVALID: invalid upload token: Signature has expired.`
 * This script speaks the same protocol but
 *   1. uploads parts with a worker pool (default 4, configurable),
 *   2. re-mints the upload token before it expires / on 401 and continues,
 *   3. resumes from `uploaded_parts` reported by `init`, so retries never
 *      re-send bytes the server already has.
 *
 * Protocol (same endpoints the CLI uses):
 *   POST /api/v1/anna-apps/dev/upload-session/mint        (PAT auth) -> upload_token
 *   POST /api/v1/anna-apps/dev/executas/{toolId}/binaries/init          -> upload_id + per-platform plan
 *   POST /api/v1/anna-apps/dev/executas/{toolId}/binaries/{uploadId}/part?platform=&index=
 *   POST /api/v1/anna-apps/dev/executas/{toolId}/binaries/{uploadId}/finalize
 *
 * Memory: peak is roughly `--concurrency` x part_size (part_size is server
 * driven, 64 MiB today). Use --concurrency 2 on memory-constrained machines.
 *
 * Usage:
 *   node scripts/upload-binary.mjs [--cwd executas/ppt-engine] [--concurrency 4]
 *                                  [--dry-run] [--host https://staging.anna.partners]
 *                                  [--tool-id tool-xxxx]
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const PART_RETRIES = 4;
const TOKEN_REFRESH_MS = 9 * 60 * 1000; // refresh well before the ~15 min TTL

function parseArgs(argv) {
  const out = { cwd: process.cwd(), concurrency: 4, dryRun: false, rounds: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") out.cwd = argv[++i];
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--rounds") out.rounds = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "--tool-id") out.toolId = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 16) {
    throw new Error("--concurrency must be an integer in 1..16");
  }
  if (!Number.isInteger(out.rounds) || out.rounds < 1 || out.rounds > 10) {
    throw new Error("--rounds must be an integer in 1..10");
  }
  return out;
}

function readCredentials() {
  const path = resolve(homedir(), ".config", "anna", "credentials.json");
  if (!existsSync(path)) throw new Error(`credentials not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveAccount(credentials, host) {
  const accounts = credentials.accounts ?? {};
  const key = host ?? credentials.current ?? Object.keys(accounts)[0];
  if (!key) throw new Error("no Anna account found in credentials.json");
  const account = accounts[key];
  if (!account) throw new Error(`no credentials for host ${key}`);
  if (!account.pat) throw new Error(`account ${key} has no PAT — run \`anna-app login\``);
  return { host: account.host ?? key, pat: account.pat };
}

function resolveToolId(cwd, explicit) {
  if (explicit) return explicit;
  const cache = resolve(cwd, ".anna", "executa.json");
  if (existsSync(cache)) {
    const parsed = JSON.parse(readFileSync(cache, "utf8"));
    if (parsed.tool_id) return parsed.tool_id;
  }
  throw new Error("no tool_id — pass --tool-id or run from a directory with .anna/executa.json");
}

function resolveArtifacts(manifest) {
  const distribution = manifest.distribution ?? {};
  const direct = distribution.binaryArtifacts ?? distribution.binary_artifacts;
  if (direct && Object.keys(direct).length > 0) return direct;
  const active = distribution.active;
  const profile = active ? distribution.profiles?.[active] : null;
  const fromProfile = profile?.binaryArtifacts ?? profile?.binary_artifacts;
  if (fromProfile && Object.keys(fromProfile).length > 0) return fromProfile;
  throw new Error("executa.json declares no binary artifacts (distribution.active profile / binary_artifacts)");
}

function expandPath(template, vars) {
  return template
    .replaceAll("{version}", vars.version)
    .replaceAll("{platform}", vars.platform)
    .replaceAll("{tool_id}", vars.toolId);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function readPart(path, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== length) throw new Error(`short read on ${path} (${offset}/${length})`);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

async function readErrorBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return { message: "(empty body)" };
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail;
    if (detail && typeof detail === "object") return { code: detail.code, message: detail.message };
    if (typeof detail === "string") return { message: detail };
    return { message: text.slice(0, 240) };
  } catch {
    return { message: text.slice(0, 240) };
  }
}

function createTransport(host, initialToken, refresh) {
  const state = { token: initialToken, mintedAt: Date.now() };
  let refreshing = null;

  async function currentToken(force) {
    if (!force && Date.now() - state.mintedAt < TOKEN_REFRESH_MS) return state.token;
    if (!refreshing) {
      refreshing = refresh()
        .then((token) => {
          state.token = token;
          state.mintedAt = Date.now();
          return token;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  async function post(path, body, raw, retryOnAuth = true) {
    const token = await currentToken(false);
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (raw !== undefined) headers["content-type"] = "application/octet-stream";
    else headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(host + path, {
        method: "POST",
        headers,
        body: raw !== undefined ? raw : JSON.stringify(body ?? {}),
      });
    } catch (error) {
      const wrapped = new Error(`network error contacting ${host}: ${error.message}`);
      wrapped.status = 0;
      throw wrapped;
    }
    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    const { code, message } = await readErrorBody(response);
    const error = new Error(`${response.status}${code ? " " + code : ""}: ${message}`);
    error.status = response.status;
    error.code = code;
    if (response.status === 401 && retryOnAuth) {
      await currentToken(true);
      return post(path, body, raw, false);
    }
    throw error;
  }

  return { post };
}

async function mintUploadToken(host, pat, toolId) {
  const response = await fetch(`${host}/api/v1/anna-apps/dev/upload-session/mint`, {
    method: "POST",
    headers: { authorization: `Bearer ${pat}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tool_id: toolId }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = parsed?.detail;
    throw new Error(`mint failed (${response.status}): ${detail?.message ?? text?.slice(0, 200) ?? "(empty)"}`);
  }
  const token = parsed?.upload_token ?? parsed?.data?.upload_token;
  if (!token) throw new Error("mint returned no upload_token");
  return token;
}

async function runPool(items, size, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/upload-binary.mjs [--cwd <executa dir>] [--concurrency N] [--dry-run] [--host <url>] [--tool-id <id>]");
    return;
  }

  const cwd = resolve(args.cwd);
  const credentials = readCredentials();
  const { host, pat } = resolveAccount(credentials, args.host);
  const manifest = JSON.parse(readFileSync(resolve(cwd, "executa.json"), "utf8"));
  const toolId = resolveToolId(cwd, args.toolId);
  const version = manifest.version;
  const artifacts = resolveArtifacts(manifest);

  console.log(`tool_id   ${toolId}`);
  console.log(`version   ${version}`);
  console.log(`host      ${host}`);

  const plan = [];
  for (const [platform, artifact] of Object.entries(artifacts)) {
    const expanded = expandPath(artifact.path, { version, platform, toolId });
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (!existsSync(abs)) throw new Error(`binary_artifacts["${platform}"]: ${abs} does not exist`);
    const size = statSync(abs).size;
    if (size <= 0 || size > MAX_ARTIFACT_BYTES) throw new Error(`binary_artifacts["${platform}"]: ${size} bytes out of range`);
    plan.push({
      platform,
      abs,
      decl: {
        filename: basename(abs),
        sha256: await sha256File(abs),
        byte_size: size,
        format: artifact.format,
        entrypoint: artifact.entrypoint,
      },
    });
  }
  plan.sort((a, b) => a.platform.localeCompare(b.platform));

  // Mint once up front; the transport refreshes on 401 or before the TTL lapses.
  const mintedToken = await mintUploadToken(host, pat, toolId);
  const liveTransport = createTransport(host, mintedToken, () => mintUploadToken(host, pat, toolId));

  const assets = {};
  for (const entry of plan) assets[entry.platform] = entry.decl;

  const init = await liveTransport.post(`/api/v1/anna-apps/dev/executas/${encodeURIComponent(toolId)}/binaries/init`, {
    executa_version: version,
    assets,
    dry_run: args.dryRun === true,
  });
  console.log(`upload_id ${init.upload_id}`);
  for (const entry of plan) {
    const asset = init.assets?.[entry.platform] ?? {};
    console.log(
      `  ${entry.platform.padEnd(16)} ${asset.status === "exists" ? "exists (skip)" : "upload"}  ` +
        `${mb(entry.decl.byte_size)} MB  parts=${asset.part_count ?? "?"}  already=${(asset.uploaded_parts ?? []).length}`,
    );
  }
  if (args.dryRun) {
    console.log("dry run — nothing uploaded");
    return;
  }

  const jobs = [];
  for (const entry of plan) {
    const asset = init.assets?.[entry.platform];
    if (!asset || asset.status === "exists") continue;
    const partSize = asset.part_size;
    const partCount = asset.part_count ?? Math.ceil(entry.decl.byte_size / partSize);
    const already = new Set(asset.uploaded_parts ?? []);
    for (let index = 0; index < partCount; index += 1) {
      if (already.has(index)) continue;
      jobs.push({
        platform: entry.platform,
        index,
        partCount,
        partSize,
        start: index * partSize,
        length: Math.min(partSize, entry.decl.byte_size - index * partSize),
        path: entry.abs,
      });
    }
  }

  if (jobs.length === 0) {
    console.log("nothing to upload — all parts already received");
  } else {
    const totalBytes = jobs.reduce((sum, job) => sum + job.length, 0);
    let doneBytes = 0;
    let doneJobs = 0;
    const startedAt = Date.now();
    console.log(`uploading ${jobs.length} part(s), ${mb(totalBytes)} MB, concurrency=${args.concurrency}`);
    // A part that keeps failing on the wire must not abandon the parts still in
    // flight: collect failures and retry them in later rounds.
    let pending = jobs;
    for (let round = 1; round <= args.rounds && pending.length > 0; round += 1) {
      const failed = [];
      await runPool(pending, args.concurrency, async (job) => {
        const bytes = readPart(job.path, job.start, job.length);
        let lastError;
        for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
          try {
            await liveTransport.post(
              `/api/v1/anna-apps/dev/executas/${encodeURIComponent(toolId)}/binaries/${encodeURIComponent(init.upload_id)}/part` +
                `?platform=${encodeURIComponent(job.platform)}&index=${job.index}`,
              undefined,
              bytes,
            );
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            const status = error.status ?? 0;
            if (status && status < 500 && status !== 429 && status !== 401) throw error;
            if (attempt < PART_RETRIES) await sleep(1000 * attempt * attempt);
          }
        }
        if (lastError) {
          console.log(`✗ ${job.platform} part ${job.index + 1}/${job.partCount} failed: ${lastError.message}`);
          failed.push(job);
          return;
        }
        doneBytes += job.length;
        doneJobs += 1;
        const elapsed = (Date.now() - startedAt) / 1000;
        const speed = elapsed > 0 ? doneBytes / (1024 * 1024) / elapsed : 0;
        console.log(
          `↑ ${job.platform} part ${job.index + 1}/${job.partCount}  ` +
            `${doneJobs}/${jobs.length} parts  ${mb(doneBytes)}/${mb(totalBytes)} MB  ${speed.toFixed(2)} MB/s`,
        );
      });
      pending = failed;
      if (pending.length > 0 && round < args.rounds) {
        console.log(`round ${round}: ${pending.length} part(s) still failing — retrying in 10s (rounds left: ${args.rounds - round})`);
        await sleep(10_000);
      }
    }
    if (pending.length > 0) {
      throw new Error(`${pending.length} part(s) could not be uploaded after ${args.rounds} round(s) — re-run to resume`);
    }
  }

  const finalized = await liveTransport.post(
    `/api/v1/anna-apps/dev/executas/${encodeURIComponent(toolId)}/binaries/${encodeURIComponent(init.upload_id)}/finalize`,
    {},
  );
  console.log("finalized:");
  console.log(JSON.stringify(finalized, null, 2));
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
