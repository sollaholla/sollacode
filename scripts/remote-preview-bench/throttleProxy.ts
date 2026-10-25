// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Loopback TCP shaper with wall-clock pacing.
import * as NodeNet from "node:net";

export interface LinkShape {
  /** Bytes per second per connection, in each direction. */
  readonly bytesPerSecond: number;
  readonly delayMs: number;
  /** Queue limit before pausing input; TCP may already have buffered more. */
  readonly queueBytes: number;
}

/** Paces real TCP payloads; every timer and socket belongs to this proxy. */
export function startThrottleProxy(targetPort: number, shape: LinkShape) {
  if (
    !Number.isFinite(shape.bytesPerSecond) ||
    shape.bytesPerSecond <= 0 ||
    !Number.isFinite(shape.delayMs) ||
    shape.delayMs < 0 ||
    !Number.isFinite(shape.queueBytes) ||
    shape.queueBytes <= 0
  ) {
    throw new Error("Invalid link shape");
  }
  const sockets = new Set<NodeNet.Socket>();
  const teardowns = new Set<() => void>();
  const server = NodeNet.createServer((client) => {
    const upstream = NodeNet.connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let disposed = false;
    const teardown = () => {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
      teardowns.delete(teardown);
    };
    teardowns.add(teardown);
    const shapeDirection = (from: NodeNet.Socket, to: NodeNet.Socket) => {
      let queued = 0;
      let nextFree = 0;
      let blocked = false;
      const resume = () => {
        if (!disposed && !blocked && queued <= shape.queueBytes / 2) from.resume();
      };
      to.on("drain", () => {
        blocked = false;
        resume();
      });
      from.on("data", (chunk: Buffer) => {
        queued += chunk.length;
        if (queued > shape.queueBytes) from.pause();
        const now = performance.now();
        nextFree = Math.max(now, nextFree) + (chunk.length / shape.bytesPerSecond) * 1000;
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (disposed) return;
            queued -= chunk.length;
            if (!to.write(chunk)) {
              blocked = true;
              from.pause();
            }
            resume();
          },
          Math.max(0, nextFree + shape.delayMs - now),
        );
        timers.add(timer);
      });
    };
    shapeDirection(client, upstream);
    shapeDirection(upstream, client);
    client.on("close", teardown);
    upstream.on("close", teardown);
    client.on("error", teardown);
    upstream.on("error", teardown);
  });
  return new Promise<{ readonly port: number; readonly close: () => Promise<void> }>(
    (resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as NodeNet.AddressInfo;
        resolve({
          port: address.port,
          close: () =>
            new Promise<void>((done, fail) => {
              for (const teardown of teardowns) teardown();
              for (const socket of sockets) socket.destroy();
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      });
    },
  );
}
