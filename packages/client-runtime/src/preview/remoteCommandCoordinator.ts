export type CoordinatedTaskResult<A> =
  | { readonly status: "current"; readonly value: A }
  | { readonly status: "stale" };

/**
 * Keeps a remote browser mirror causally ordered.
 *
 * Input runs one action at a time so a tap, type, and Enter cannot overtake
 * each other on a slow relay. Captures may run concurrently, but only the
 * newest completion in the current tab scope is allowed to update the frame.
 */
export class RemotePreviewCommandCoordinator {
  private inputTail: Promise<void> = Promise.resolve();
  private scope = 0;
  private captureSequence = 0;

  reset(): void {
    this.scope += 1;
    this.captureSequence += 1;
    // A request already sent to the old tab cannot be cancelled, but it must
    // not hold the new tab's lane until a slow relay times out.
    this.inputTail = Promise.resolve();
  }

  queueInput<A>(task: () => Promise<A>): Promise<CoordinatedTaskResult<A>> {
    const scope = this.scope;
    const started = this.inputTail
      .catch(() => undefined)
      .then(async () => {
        if (scope !== this.scope) return { status: "stale" } as const;
        const value = await task();
        return scope === this.scope
          ? ({ status: "current", value } as const)
          : ({ status: "stale" } as const);
      });
    this.inputTail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  latestCapture<A>(task: () => Promise<A>): Promise<CoordinatedTaskResult<A>> {
    const scope = this.scope;
    const sequence = ++this.captureSequence;
    return task().then((value) =>
      scope === this.scope && sequence === this.captureSequence
        ? { status: "current", value }
        : { status: "stale" },
    );
  }
}
