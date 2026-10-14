import type { DesignProfile } from "./types";

/**
 * Structured edit operations produced by the LLM chat assistant inside the
 * profile confirmation gate. Kept deliberately small so the model output is
 * easy to validate and the UI can render a human-readable diff summary.
 */

export type ProfileOpSection = "colors" | "typography" | "layout_rules" | "fixed_assets" | "voice" | "do" | "dont";

export interface ProfileOp {
  op: "set" | "add" | "update" | "remove";
  section: ProfileOpSection;
  /** index for update/remove (and optional insert position for add) */
  index?: number;
  /** whole-section value for set / item value for add/update */
  value?: unknown;
}

export interface ProfileOpsResult {
  profile: DesignProfile;
  applied: number;
  skipped: string[];
}

const ARRAY_SECTIONS = new Set<ProfileOpSection>(["colors", "layout_rules", "fixed_assets", "do", "dont"]);
const SECTIONS = new Set<string>(["colors", "typography", "layout_rules", "fixed_assets", "voice", "do", "dont"]);
const LIMITS: Record<string, number> = { colors: 6, layout_rules: 12, fixed_assets: 4, do: 10, dont: 10 };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate an arbitrary model payload into a clean op list; throws on malformed input. */
export function parseProfileOps(value: unknown): ProfileOp[] {
  if (!isObject(value) || !Array.isArray(value.ops)) throw new Error("Assistant response must be an object with an \"ops\" array");
  return value.ops.map((raw, i) => {
    if (!isObject(raw)) throw new Error(`Op #${i + 1} must be an object`);
    const { op, section, index, value: opValue } = raw;
    if (op !== "set" && op !== "add" && op !== "update" && op !== "remove") throw new Error(`Op #${i + 1} has unknown action "${String(op)}"`);
    if (typeof section !== "string" || !SECTIONS.has(section)) throw new Error(`Op #${i + 1} has unknown section "${String(section)}"`);
    const normalized: ProfileOp = { op, section: section as ProfileOpSection };
    if (index !== undefined) {
      if (!Number.isInteger(index) || (index as number) < 0) throw new Error(`Op #${i + 1} has an invalid index`);
      normalized.index = index as number;
    }
    if (op !== "remove") {
      if (opValue === undefined) throw new Error(`Op #${i + 1} needs a "value"`);
      normalized.value = opValue;
    }
    return normalized;
  });
}

function validColor(value: unknown): boolean {
  return isObject(value) && isNonEmptyString(value.hex) && /^#[0-9A-Fa-f]{6}$/.test(value.hex) && isNonEmptyString(value.token);
}

function validAsset(value: unknown): boolean {
  return isObject(value) && value.kind === "logo" && isNonEmptyString(value.label);
}

function normalizeArray(section: ProfileOpSection, value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const limit = LIMITS[section] ?? 20;
  if (value.length > limit) return null;
  switch (section) {
    case "colors": return value.every(validColor) ? value.map((c) => ({ ...c, token: String(c.token).trim() })) : null;
    case "fixed_assets": return value.every(validAsset) ? value.map((a) => ({ kind: "logo" as const, ...a })) : null;
    case "layout_rules": case "do": case "dont":
      return value.every((line) => typeof line === "string" && line.trim().length > 0) ? value.map((line) => String(line).trim()) : null;
    default: return null;
  }
}

/** Apply ops immutably to a profile draft. Invalid ops are skipped with a reason, never thrown. */
export function applyProfileOps(profile: DesignProfile, ops: ProfileOp[]): ProfileOpsResult {
  let next: DesignProfile = profile;
  let applied = 0;
  const skipped: string[] = [];
  const fail = (reason: string) => { skipped.push(reason); };

  for (const item of ops) {
    const { op, section, index, value } = item;
    if (op === "set") {
      if (section === "typography") {
        if (!isObject(value)) { fail(`typography: value must be an object`); continue; }
        next = { ...next, typography: { ...next.typography, ...value } };
      } else if (section === "voice") {
        if (typeof value !== "string" || value.trim().length > 300) { fail(`voice: value must be a string (max 300 chars)`); continue; }
        next = { ...next, voice: value.trim() || undefined };
      } else {
        const list = normalizeArray(section, value);
        if (!list) { fail(`${section}: invalid list value`); continue; }
        if (section === "colors" && list.length < 1) { fail(`colors: need at least 1 color`); continue; }
        next = { ...next, [section]: list };
      }
      applied += 1;
      continue;
    }

    if (section === "typography" || section === "voice") { fail(`${section}: only "set" is supported`); continue; }
    const list = (next[section] ?? []) as unknown[];
    if (op === "add") {
      const limit = LIMITS[section] ?? 20;
      if (list.length >= limit) { fail(`${section}: already at the ${limit}-item limit`); continue; }
      const candidate = Array.isArray(value) && section !== "layout_rules" && section !== "do" && section !== "dont" ? value : [value];
      const merged = index === undefined ? [...list, ...candidate] : [...list.slice(0, index), ...candidate, ...list.slice(index)];
      const normalized = normalizeArray(section, merged);
      if (!normalized) { fail(`${section}: invalid item value`); continue; }
      next = { ...next, [section]: normalized };
      applied += 1;
      continue;
    }
    if (index === undefined || index >= list.length) { fail(`${section}: index ${String(index)} is out of range`); continue; }
    if (op === "remove") {
      next = { ...next, [section]: list.filter((_, i) => i !== index) };
      applied += 1;
      continue;
    }
    // update
    if (section === "colors" || section === "fixed_assets") {
      if (!isObject(value)) { fail(`${section}[${index}]: value must be an object`); continue; }
      const current = list[index] as Record<string, unknown>;
      const merged = { ...current, ...value };
      if (!normalizeArray(section, list.map((entry, i) => (i === index ? merged : entry)))) { fail(`${section}[${index}]: merged item is invalid`); continue; }
      next = { ...next, [section]: list.map((entry, i) => (i === index ? merged : entry)) };
    } else {
      if (typeof value !== "string" || !value.trim()) { fail(`${section}[${index}]: value must be a non-empty string`); continue; }
      next = { ...next, [section]: list.map((entry, i) => (i === index ? value.trim() : entry)) };
    }
    applied += 1;
  }
  return { profile: next, applied, skipped };
}
