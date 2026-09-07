/**
 * Fields of a thread session that carry information, i.e. everything except
 * `updatedAt`.
 */
export interface ProviderSessionWriteFields {
  readonly status: string;
  readonly providerName: string | null;
  readonly providerInstanceId: string | undefined;
  readonly runtimeMode: string;
  readonly activeTurnId: string | null;
  readonly lastError: string | null | undefined;
  readonly failureKind: string | null | undefined;
}

function normalize(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * Whether writing this session tells the thread anything it does not know.
 *
 * `session.state.changed` arrives repeatedly while a turn runs, and for the
 * whole of that turn it resolves to the same session: status "running", the
 * same active turn, no error. Writing it anyway appends an event, re-projects
 * the thread and pushes a NEW session object to every connected client — 601
 * times in 40 minutes on one thread, measured 2026-09-06, every one of them
 * identical but for its timestamp. That is what made the UI visibly churn:
 * each push is a fresh object identity, so every derivation hanging off
 * `thread.session` recomputes and the view re-renders.
 *
 * Suppressing them is safe because nothing reads the session's `updatedAt` as
 * a heartbeat. Runtime liveness reaches the scheduler through
 * `observeRuntime`, which runs on its own path before this one, and the
 * decider's compare-and-set uses `updatedAt` only to detect a session it did
 * not expect — fewer writes cannot invent one.
 */
export function providerSessionWriteIsNews(
  current: ProviderSessionWriteFields | undefined,
  next: ProviderSessionWriteFields,
): boolean {
  if (current === undefined) return true;
  return (
    current.status !== next.status ||
    normalize(current.providerName) !== normalize(next.providerName) ||
    normalize(current.providerInstanceId) !== normalize(next.providerInstanceId) ||
    current.runtimeMode !== next.runtimeMode ||
    normalize(current.activeTurnId) !== normalize(next.activeTurnId) ||
    normalize(current.lastError) !== normalize(next.lastError) ||
    normalize(current.failureKind) !== normalize(next.failureKind)
  );
}
