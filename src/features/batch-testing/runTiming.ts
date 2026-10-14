import type { BatchTestRunRecord } from "../../api/types";
import type { Locale } from "../../i18n/messages";
import { locales } from "../../i18n/locales";

export function formatBatchTestDate(value: string | null, locale: Locale) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locales[locale].intl, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBatchTestDuration(run: BatchTestRunRecord, now = Date.now()) {
  if (!run.started_at) return "-";
  const start = new Date(run.started_at).getTime();
  const end = run.ended_at
    ? new Date(run.ended_at).getTime()
    : run.status === "running" ? now : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
