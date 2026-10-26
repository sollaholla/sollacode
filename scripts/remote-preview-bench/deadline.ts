// @effect-diagnostics globalTimers:off - Bounds standalone benchmark operations on wall-clock time.

/** Cancel the deadline when the operation finishes, so successful runs can exit immediately. */
export async function waitWithTimeout<A, B>(
  operation: Promise<A>,
  milliseconds: number,
  timeoutValue: B,
): Promise<A | B> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<B>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
