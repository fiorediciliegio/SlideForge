export interface StreamLivenessTimer {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timeoutId: unknown): void;
}

export interface StreamLivenessGuardOptions {
  idleMs: number;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  timer?: StreamLivenessTimer;
  cancelPollMs?: number;
  /** Stops local observation when the enclosing run times out. */
  stopSignal?: AbortSignal;
  onIteratorDone?: () => void;
  onCleanup?: (status: "requested" | "resolved" | "rejected" | "unavailable") => void;
}

export class StreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Agent stream idle timeout after ${idleMs}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

export class StreamCancelledError extends Error {
  constructor() {
    super("Agent stream cancelled");
    this.name = "StreamCancelledError";
  }
}

export function isStreamIdleTimeoutError(error: unknown): error is StreamIdleTimeoutError {
  return error instanceof StreamIdleTimeoutError;
}

export function isStreamCancelledError(error: unknown): error is StreamCancelledError {
  return error instanceof StreamCancelledError;
}

const defaultTimer: StreamLivenessTimer = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
};

function cancelled(options: StreamLivenessGuardOptions) {
  return options.signal?.aborted === true || options.stopSignal?.aborted === true || options.isCancelled?.() === true;
}

async function nextWithLiveness<T>(
  iterator: AsyncIterator<T>,
  options: StreamLivenessGuardOptions,
): Promise<IteratorResult<T>> {
  const timer = options.timer ?? defaultTimer;
  let idleId: unknown;
  let pollId: unknown;
  let removeAbortListener: (() => void) | undefined;

  const idlePromise = new Promise<never>((_, reject) => {
    idleId = timer.setTimeout(
      () => reject(new StreamIdleTimeoutError(options.idleMs)),
      options.idleMs,
    );
  });

  const cancelPromise = new Promise<never>((_, reject) => {
    const rejectCancelled = () => reject(new StreamCancelledError());
    const signals = [options.signal, options.stopSignal].filter((signal): signal is AbortSignal => Boolean(signal));
    for (const signal of signals) signal.addEventListener("abort", rejectCancelled, { once: true });
    removeAbortListener = () => signals.forEach((signal) => signal.removeEventListener("abort", rejectCancelled));
    if (options.isCancelled) {
      const poll = () => {
        if (options.isCancelled?.()) {
          rejectCancelled();
          return;
        }
        pollId = timer.setTimeout(poll, options.cancelPollMs ?? 100);
      };
      pollId = timer.setTimeout(poll, options.cancelPollMs ?? 100);
    }
  });

  try {
    return await Promise.race([iterator.next(), idlePromise, cancelPromise]);
  } finally {
    if (idleId !== undefined) timer.clearTimeout(idleId);
    if (pollId !== undefined) timer.clearTimeout(pollId);
    removeAbortListener?.();
  }
}

export async function* guardStreamLiveness<T>(
  stream: AsyncIterable<T>,
  options: StreamLivenessGuardOptions,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let exhausted = false;
  const notify = (callback: (() => void) | undefined) => {
    try { callback?.(); } catch { /* Diagnostic observers must not affect the stream. */ }
  };

  try {
    for (;;) {
      if (cancelled(options)) {
        throw new StreamCancelledError();
      }

      const result = await nextWithLiveness(iterator, options);

      if (result.done) {
        exhausted = true;
        notify(options.onIteratorDone);
        return;
      }
      yield result.value;
    }
  } finally {
    if (!exhausted) {
      // Forward consumer break/errors as well as idle/cancel. Never await return:
      // async generators may queue it behind a next() that never settles.
      try {
        if (typeof iterator.return !== "function") {
          notify(() => options.onCleanup?.("unavailable"));
        } else {
          notify(() => options.onCleanup?.("requested"));
          void Promise.resolve(iterator.return()).then(
            () => notify(() => options.onCleanup?.("resolved")),
            () => notify(() => options.onCleanup?.("rejected")),
          );
        }
      } catch {
        notify(() => options.onCleanup?.("rejected"));
      }
    }
  }
}
