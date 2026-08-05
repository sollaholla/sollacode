export interface RemoteControlVideoProducerPacer {
  readonly state: string;
  pause(): void;
  resume(): void;
}

export interface RemoteControlVideoPublishQueueStats {
  readonly pendingBytes: number;
  readonly pendingItems: number;
  readonly closed: boolean;
}

export interface RemoteControlVideoPublishQueue<T> {
  /**
   * Retains one encoded chunk for ordered publication. Returns false once the
   * queue has closed or when accepting the item would exceed its byte budget.
   */
  enqueue(item: T, pacer: RemoteControlVideoProducerPacer): boolean;
  /** Releases queued blobs immediately. An already-running publish is allowed to settle. */
  close(): void;
  /** Resolves when no retained item remains, including an in-flight publish. */
  whenIdle(): Promise<void>;
  stats(): RemoteControlVideoPublishQueueStats;
}

interface QueueEntry<T> {
  readonly item: T;
  readonly size: number;
  readonly pacer: RemoteControlVideoProducerPacer;
}

export function createRemoteControlVideoPublishQueue<T>(options: {
  readonly maxPendingBytes: number;
  readonly pauseAtBytes: number;
  readonly resumeAtBytes: number;
  readonly sizeOf: (item: T) => number;
  readonly publish: (item: T) => Promise<void>;
  readonly onError: (cause: unknown) => void;
}): RemoteControlVideoPublishQueue<T> {
  if (
    !Number.isFinite(options.maxPendingBytes) ||
    options.maxPendingBytes <= 0 ||
    !Number.isFinite(options.pauseAtBytes) ||
    options.pauseAtBytes <= 0 ||
    options.pauseAtBytes > options.maxPendingBytes ||
    !Number.isFinite(options.resumeAtBytes) ||
    options.resumeAtBytes < 0 ||
    options.resumeAtBytes >= options.pauseAtBytes
  ) {
    throw new Error("Invalid remote-control video queue byte limits.");
  }

  const queued: Array<QueueEntry<T>> = [];
  const pausedPacers = new Set<RemoteControlVideoProducerPacer>();
  const idleWaiters = new Set<() => void>();
  let current: QueueEntry<T> | null = null;
  let pendingBytes = 0;
  let draining = false;
  let closed = false;
  let errorReported = false;

  const pendingItems = () => queued.length + (current === null ? 0 : 1);

  const resolveIdle = () => {
    if (pendingBytes !== 0 || pendingItems() !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const clearQueued = () => {
    for (const entry of queued) pendingBytes -= entry.size;
    queued.length = 0;
    pausedPacers.clear();
    resolveIdle();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearQueued();
  };

  const fail = (cause: unknown) => {
    if (errorReported) return;
    errorReported = true;
    close();
    options.onError(cause);
  };

  const pauseProducer = (pacer: RemoteControlVideoProducerPacer) => {
    if (pendingBytes < options.pauseAtBytes || pacer.state !== "recording") return;
    try {
      pacer.pause();
      pausedPacers.add(pacer);
    } catch (cause) {
      fail(cause);
    }
  };

  const resumeProducers = () => {
    if (closed || pendingBytes > options.resumeAtBytes) return;
    for (const pacer of pausedPacers) {
      if (pacer.state !== "paused") {
        pausedPacers.delete(pacer);
        continue;
      }
      try {
        pacer.resume();
        pausedPacers.delete(pacer);
      } catch (cause) {
        fail(cause);
        return;
      }
    }
  };

  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed && queued.length > 0) {
        current = queued.shift()!;
        try {
          await options.publish(current.item);
        } catch (cause) {
          pendingBytes -= current.size;
          current = null;
          fail(cause);
          break;
        }
        pendingBytes -= current.size;
        current = null;
        resumeProducers();
        resolveIdle();
      }
    } finally {
      draining = false;
      resolveIdle();
    }
  };

  return {
    enqueue(item, pacer) {
      if (closed) return false;
      const size = options.sizeOf(item);
      if (!Number.isSafeInteger(size) || size <= 0) {
        fail(new Error("Remote-control video encoder produced an invalid chunk size."));
        return false;
      }
      if (size > options.maxPendingBytes || pendingBytes + size > options.maxPendingBytes) {
        fail(
          new Error(
            `Remote-control video publishing fell behind its ${options.maxPendingBytes}-byte buffer.`,
          ),
        );
        return false;
      }

      queued.push({ item, size, pacer });
      pendingBytes += size;
      pauseProducer(pacer);
      if (!closed) void drain();
      return !closed;
    },
    close,
    whenIdle() {
      if (pendingBytes === 0 && pendingItems() === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    stats() {
      return {
        pendingBytes,
        pendingItems: pendingItems(),
        closed,
      };
    },
  };
}
