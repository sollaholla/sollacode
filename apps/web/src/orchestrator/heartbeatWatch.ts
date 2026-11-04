/** How long one beat may take before it counts as missed. */
export const HEARTBEAT_TIMEOUT_MS = 6_000;
/** Beats missed in a row that mean the link is gone, not just slow. */
export const HEARTBEAT_MISSES_TO_LOSE = 3;
/** A miss is retried this soon, so a real drop is found in seconds rather than minutes. */
export const HEARTBEAT_RETRY_MS = 3_000;

export interface HeartbeatWatch {
  stop(): void;
}

/**
 * Beats a leased call session and notices when the host can no longer be
 * reached. The voice runs on its own connection, so it can outlive the link to
 * the host: the host hangs up when the lease lapses, while this device goes on
 * showing a call and playing typing for work it will never hear about.
 *
 * Misses don't count while the page is hidden. A locked phone can suspend the
 * page's requests while the call is fine, and a connection that really died
 * also takes the voice's, which has its own watch.
 */
export function startHeartbeatWatch(input: {
  readonly everyMs: number;
  readonly beat: (signal: AbortSignal) => Promise<Response>;
  /** The host answered that it no longer holds this session. */
  readonly onRefused: () => void;
  readonly onLost: () => void;
  readonly isHidden?: () => boolean;
}): HeartbeatWatch {
  const isHidden = input.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
  let stopped = false;
  let missed = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let beating = false;

  const schedule = (delayMs: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
  };
  const tick = async () => {
    timer = null;
    if (stopped || beating) return;
    beating = true;
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const response = await input.beat(abort.signal);
      if (stopped) return;
      missed = 0;
      if (response.status === 409) {
        input.onRefused();
        return;
      }
      schedule(input.everyMs);
    } catch {
      if (stopped) return;
      if (isHidden()) {
        schedule(input.everyMs);
        return;
      }
      missed += 1;
      if (missed >= HEARTBEAT_MISSES_TO_LOSE) {
        input.onLost();
        return;
      }
      schedule(HEARTBEAT_RETRY_MS);
    } finally {
      clearTimeout(deadline);
      beating = false;
    }
  };
  // The browser already knows: check now rather than at the next beat.
  const onOffline = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    void tick();
  };
  if (typeof window !== "undefined") window.addEventListener("offline", onOffline);
  schedule(input.everyMs);
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (typeof window !== "undefined") window.removeEventListener("offline", onOffline);
    },
  };
}
