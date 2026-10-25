/**
 * The desktop's frame pipeline for one watched tab: captured pictures arrive
 * faster than they can be encoded and sent, so only the newest waits. One
 * picture is processed at a time, at most one per `minIntervalMs`; a picture
 * that arrives while another is in flight replaces any picture still waiting,
 * and the last one is always processed, so the viewer ends on what the page
 * actually shows.
 */
export interface LatestFramePipeline<F> {
  /** Offers the newest captured picture. */
  readonly push: (frame: F) => void;
  /**
   * Holds pictures back (the page is loading, say) without dropping the
   * newest; processing resumes with it once released.
   */
  readonly setPaused: (paused: boolean) => void;
  readonly dispose: () => void;
}

export interface PipelineScheduler {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export function createLatestFramePipeline<F>(options: {
  readonly process: (frame: F) => Promise<void>;
  readonly minIntervalMs: number;
  readonly scheduler: PipelineScheduler;
  readonly onError?: (error: unknown) => void;
}): LatestFramePipeline<F> {
  let waiting: { readonly frame: F } | null = null;
  let running = false;
  let paused = false;
  let disposed = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Pausing/disposal can occur while an awaited process is running.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!disposed && !paused && waiting !== null) {
        const gap = lastStartedAt + options.minIntervalMs - options.scheduler.now();
        if (gap > 0) {
          await options.scheduler.sleep(gap);
          continue;
        }
        const { frame } = waiting;
        waiting = null;
        lastStartedAt = options.scheduler.now();
        try {
          await options.process(frame);
        } catch (error) {
          options.onError?.(error);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    push: (frame) => {
      if (disposed) return;
      waiting = { frame };
      void run();
    },
    setPaused: (next) => {
      paused = next;
      if (!paused) void run();
    },
    dispose: () => {
      disposed = true;
      waiting = null;
    },
  };
}
