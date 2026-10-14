/** Only an explicit true enables diagnostic recording in an App build. */
export function isDiagnosticLoggingEnabled(
  value: unknown = import.meta.env?.VITE_PPT_LOG_ENABLED,
): boolean {
  return value === "true";
}
