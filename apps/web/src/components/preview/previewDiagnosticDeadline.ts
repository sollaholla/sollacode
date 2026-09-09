/** Optional renderer diagnostics must not hold a completed browser action open. */
export async function readPreviewDiagnostic<A>(
  read: () => Promise<A>,
  fallback: A,
  timeoutMs = 750,
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .catch(() => fallback),
      new Promise<A>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
