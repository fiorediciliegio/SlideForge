import type { AuditRect, AuditSeverity } from "./types.js";

export function rectArea(rect: AuditRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function intersectRects(first: AuditRect, second: AuditRect): AuditRect | null {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y, right, bottom };
}

export function overflowDelta(rect: AuditRect, canvas: { width: number; height: number }): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: Math.max(0, -rect.x),
    top: Math.max(0, -rect.y),
    right: Math.max(0, rect.right - canvas.width),
    bottom: Math.max(0, rect.bottom - canvas.height),
  };
}

export function classifyOverlapSeverity(
  ratio: number,
  thresholds = { warning: 0.01, suspicious: 0.1, error: 0.3 },
): AuditSeverity | "ignored" {
  if (ratio < thresholds.warning) return "ignored";
  if (ratio < thresholds.suspicious) return "warning";
  if (ratio < thresholds.error) return "suspicious";
  return "error";
}

export function isMeaningfulOverflow(delta: { left: number; top: number; right: number; bottom: number }, tolerance = 1): boolean {
  return Math.max(delta.left, delta.top, delta.right, delta.bottom) > tolerance;
}
