import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePreviewResources, rewriteHtmlResourceReferences } from "../src/page-html-preview/resources.js";
import { createPreviewResourceResolver, type PreviewApsClient } from "../src/page-html-preview/aps-resources.js";
import { ApsFilesClient } from "../aps-files-client.js";

test("preview accepts APS timezone-less five-minute expiry and still rejects expired or invalid values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-expiry-"));
  let expiry = new Date(Date.now() + 300_000).toISOString().slice(0, -1);
  const client = new ApsFilesClient({ writeFrame(message: { id: string; method: string; params: { prefix: string } }) {
    queueMicrotask(() => client.dispatchResponse({ id: message.id, result: message.method === "files/list"
      ? { files: [{ path: message.params.prefix, size_bytes: 5 }] }
      : { get_url: "https://storage.example/image", expires_at: expiry } }));
  } });
  const resource = { bytes: Buffer.from("image"), mimeType: "image/png", extension: ".png" };
  try {
    const resolve = () => createPreviewResourceResolver({ client, indexDirectory: root })(resource);
    const result = await resolve();
    assert.equal(result.expires_at, `${expiry}Z`);
    assert.ok(Date.parse(result.expires_at) - Date.now() > 240_000);
    expiry = new Date(Date.now() - 300_000).toISOString().slice(0, -1);
    await assert.rejects(resolve(), /download URL or expiry is invalid/);
    expiry = "invalid";
    await assert.rejects(resolve(), /download URL or expiry is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resource projection handles entities, CSS, srcset, SVG, removes scripts and rejects traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-"));
  try {
    await mkdir(path.join(root, "page-assets"));
    const file = path.join(root, "page-assets", "a&b.png");
    await writeFile(file, "image");
    const escaped = file.replaceAll("&", "&amp;");
    let calls = 0;
    const original = `<html><head><style>.photo{background:url('${file}')}</style><script>alert(1)</script></head><body onload="bad()"><img src="${escaped}" srcset="${escaped} 1x, ${escaped} 2x"><img srcset="${escaped}, ${escaped}" style="background-image:image-set(url('${file}') 1x)"><svg><image href="${escaped}" /></svg><iframe src="https://evil.test"></iframe></body></html>`;
    const result = await preparePreviewResources({ workspaceDir: root, htmlPath: path.join(root, "page.html"), html: original,
      resolve: async () => { calls++; return { url: "https://example.test/image?signature=a&b=c", expires_at: "2099-01-01T00:00:00Z" }; } });
    assert.equal(calls, 1);
    assert.ok(!result.html.includes(root));
    assert.ok(!result.html.includes("<script"));
    assert.ok(!result.html.includes("<iframe"));
    assert.ok(!result.html.includes("onload="));
    assert.ok(result.html.includes("Content-Security-Policy"));
    assert.ok(result.html.includes(" 2x"));
    assert.equal(result.resources_expires_at, "2099-01-01T00:00:00Z");
    assert.equal(await readFile(file, "utf8"), "image");
    const outside = path.join(root, "private.png");
    await writeFile(outside, "private");
    await symlink(outside, path.join(root, "page-assets", "escape.png"));
    await assert.rejects(preparePreviewResources({ workspaceDir: root, htmlPath: path.join(root, "page.html"), html: `<img src="${root}/page-assets/escape.png">`, resolve: async () => { throw new Error("must not upload"); } }), /outside allowed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("APS persists identity, reuses after restart, merges concurrent uploads and does not retry permission errors as missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-aps-"));
  const objects = new Map<string, { path: string; size_bytes: number; etag: string }>();
  let uploads = 0, downloads = 0;
  const client: PreviewApsClient = {
    list: async ({ prefix }) => ({ files: [...objects.values()].filter((entry) => entry.path === prefix) }),
    uploadBegin: async () => { uploads++; return { put_url: "https://example.test/put" }; },
    uploadComplete: async (input) => { const value = { path: input.path, size_bytes: input.sizeBytes, etag: "etag" }; objects.set(input.path, value); return value; },
    downloadUrl: async () => ({ url: `https://example.test/get?version=${++downloads}`, expires_at: "2099-01-01T00:00:00Z" }),
  };
  const options = { client, indexDirectory: root, fetch: (async () => new Response(null, { status: 200 })) as typeof fetch };
  const resource = { bytes: Buffer.from("image"), mimeType: "image/png", extension: ".png" };
  try {
    const first = createPreviewResourceResolver(options);
    await Promise.all([first(resource), first(resource), createPreviewResourceResolver(options)(resource)]);
    assert.equal(uploads, 1);
    const files = await readdir(root);
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(root, files[0]), "utf8"));
    assert.ok(record.aps_path);
    assert.equal(record.url, undefined);
    await createPreviewResourceResolver(options)(resource);
    assert.equal(uploads, 1);
    objects.clear();
    await createPreviewResourceResolver(options)(resource);
    assert.equal(uploads, 2);
    await createPreviewResourceResolver(options)({ ...resource, bytes: Buffer.from("changed") });
    assert.equal(uploads, 3);
    await assert.rejects(createPreviewResourceResolver({ ...options, client: { ...client, list: async () => { throw new Error("permission denied"); } } })(resource), /permission denied/);
    assert.equal(uploads, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("APS diagnostics explain expiry failures without logging signed URLs or provider secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-diagnostics-"));
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  const secret = "DO_NOT_LOG_PROVIDER_SECRET";
  const client: PreviewApsClient = {
    list: async ({ prefix }) => ({ files: [{ path: prefix, size_bytes: 5 }] }),
    uploadBegin: async () => { throw new Error("must reuse existing resource"); },
    uploadComplete: async () => { throw new Error("must reuse existing resource"); },
    downloadUrl: async () => ({ get_url: `https://example.test/private/${secret}?signature=${secret}`,
      expires_in: 3600, token: secret, metadata: { authorization: secret } }),
  };
  const options = { client, indexDirectory: root,
    onEvent: (phase: string, details: Record<string, unknown>) => events.push({ phase, details }) };
  const resource = { bytes: Buffer.from("image"), mimeType: "image/png", extension: ".png" };
  try {
    await assert.rejects(createPreviewResourceResolver(options)(resource), /download URL or expiry is invalid/);
    const response = events.find((event) => event.phase === "download-url-response")!.details;
    assert.deepEqual(response.validation_reasons, ["expires_at_missing_or_not_string"]);
    assert.deepEqual((response.expiry_fields as Record<string, unknown>).expires_in,
      { present: true, type: "number", value: 3600, redacted: false });
    assert.deepEqual((response.url_fields as Record<string, unknown>).get_url,
      { present: true, type: "string", protocol: "https:" });
    assert.equal(events.at(-1)!.details.stage, "download-url-validation");
    assert.equal(typeof response.duration_ms, "number");
    assert.ok(!JSON.stringify(events).includes(secret));

    events.length = 0;
    client.downloadUrl = async () => ({ url: `http://example.test/${secret}`, expires_at: "2000-01-01T00:00:00Z" });
    await assert.rejects(createPreviewResourceResolver(options)(resource));
    assert.deepEqual(events.find((event) => event.phase === "download-url-response")!.details.validation_reasons,
      ["url_not_https", "expires_at_insufficient_remaining_time"]);

    events.length = 0;
    client.downloadUrl = async () => { throw Object.assign(new Error(`https://example.test/?signature=${secret}`), { code: -32030 }); };
    await assert.rejects(createPreviewResourceResolver(options)(resource));
    assert.equal(events.at(-1)!.details.stage, "download-url-request");
    assert.equal(events.at(-1)!.details.error_code, -32030);
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resource rewrite skips unparseable css with a warning and still rewrites the rest", async () => {
  const warnings: string[] = [];
  const html = [
    "<!doctype html><html><head>",
    '<style>.ok{background:url("https://example.com/a.png")}</style>',
    "<style>700</style>",
    "</head><body>",
    '<div style="700">bad inline</div>',
    '<div style="font-weight:700">good inline</div>',
    "</body></html>",
  ].join("");
  const output = await rewriteHtmlResourceReferences(
    html,
    async (reference) => `https://cdn.example.com/${reference}`,
    (message) => warnings.push(message),
  );
  // The valid stylesheet and the valid inline style still get rewritten.
  assert.match(output, /https:\/\/cdn\.example\.com\/https:\/\/example\.com\/a\.png/);
  assert.match(output, /font-weight: ?700/);
  // The malformed nodes keep their original bytes instead of failing the page.
  assert.match(output, /<style>700<\/style>/);
  assert.match(output, /<div style="700">bad inline<\/div>/);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((message) => /stylesheet/.test(message) && /Unknown word 700/.test(message)));
  assert.ok(warnings.some((message) => /inline style attribute/.test(message)));
  assert.ok(warnings.every((message) => /snippet=/.test(message)));
});
