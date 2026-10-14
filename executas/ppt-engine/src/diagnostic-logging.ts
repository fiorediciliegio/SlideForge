import { AsyncLocalStorage } from "node:async_hooks";

const loggingContext = new AsyncLocalStorage<boolean>();
let backgroundLoggingEnabled = false;

export function isDiagnosticLoggingEnabled(): boolean {
  return loggingContext.getStore() ?? backgroundLoggingEnabled;
}

/** The App supplies its build setting on every invoke, including after restart. */
export function runWithDiagnosticLogging<T>(enabled: boolean, operation: () => T): T {
  backgroundLoggingEnabled = enabled;
  // In-flight calls and their child jobs retain their own setting; the periodic
  // background sweep uses the latest setting received by this App's engine.
  return loggingContext.run(enabled, operation);
}

/**
 * Enables logging only for one awaited operation. Unlike the user-controlled
 * diagnostic switch it never changes the background setting. Use this for
 * small lifecycle audit records that are required to verify a production
 * operation, rather than for diagnostic telemetry.
 */
export function runWithRequiredLifecycleLogging<T>(operation: () => T): T {
  return loggingContext.run(true, operation);
}
