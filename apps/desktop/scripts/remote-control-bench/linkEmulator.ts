/**
 * A TCP proxy that behaves like a bottleneck link: each direction serializes
 * bytes at `rateBitsPerSecond`, then delays them by half the round trip. Bytes
 * waiting to be serialized sit in a bounded buffer; once it is full the proxy
 * stops reading, so TCP backpressure reaches the sender exactly as it would
 * behind a real slow link. It also counts the bytes each connection carries,
 * which is what "bytes on the wire" means in the report: WebSocket framing and
 * permessage-deflate included.
 */
import * as NodeNet from "node:net";

export interface LinkConditions {
  readonly name: string;
  readonly rttMs: number;
  /** Infinity for an unshaped link. */
  readonly rateBitsPerSecond: number;
  /** Bottleneck buffer, in milliseconds of serialization at the link rate. */
  readonly bufferMs: number;
}

export const LOOPBACK: LinkConditions = {
  name: "loopback",
  rttMs: 0,
  rateBitsPerSecond: Number.POSITIVE_INFINITY,
  bufferMs: 0,
};

export interface ConnectionBytes {
  path: string;
  downstream: number;
  upstream: number;
}

export interface LinkEmulator {
  readonly port: number;
  setConditions(conditions: LinkConditions): void;
  /** Bytes per connection since the last reset, keyed by request path. */
  snapshot(): ConnectionBytes[];
  reset(): void;
  close(): Promise<void>;
}

const PIECE_BYTES = 16 * 1_024;

interface Pipe {
  push(chunk: Buffer): void;
  destroy(): void;
}

export function createPipe(
  source: Pick<NodeNet.Socket, "pause" | "resume">,
  target: Pick<NodeNet.Socket, "write" | "on" | "off" | "destroyed">,
  conditions: () => LinkConditions,
  onBytes: (bytes: number) => void,
): Pipe {
  const queue: Array<{ readonly at: number; readonly data: Buffer }> = [];
  let serializedUntil = 0;
  let timer: NodeJS.Timeout | null = null;
  let paused = false;
  let blocked = false;
  let disposed = false;

  const pause = () => {
    paused = true;
    source.pause();
  };

  const write = (data: Buffer) => {
    if (target.destroyed) return;
    onBytes(data.length);
    if (!target.write(data)) {
      blocked = true;
      pause();
    }
  };

  const flush = () => {
    timer = null;
    if (disposed || blocked) return;
    const now = performance.now();
    while (queue.length > 0 && queue[0]!.at <= now + 0.5) {
      const piece = queue.shift()!;
      write(piece.data);
      if (blocked) break;
    }
    const current = conditions();
    if (!blocked && paused && (queue.length === 0 || serializedUntil - now < current.bufferMs)) {
      paused = false;
      source.resume();
    }
    if (!blocked && queue.length > 0) timer = setTimeout(flush, Math.max(0, queue[0]!.at - now));
  };
  const onDrain = () => {
    blocked = false;
    flush();
  };
  target.on("drain", onDrain);

  return {
    push(chunk) {
      if (disposed) return;
      const current = conditions();
      if (
        !blocked &&
        !Number.isFinite(current.rateBitsPerSecond) &&
        current.rttMs === 0 &&
        queue.length === 0
      ) {
        write(chunk);
        return;
      }
      const now = performance.now();
      for (let offset = 0; offset < chunk.length; offset += PIECE_BYTES) {
        const data = chunk.subarray(offset, offset + PIECE_BYTES);
        const serialization = Number.isFinite(current.rateBitsPerSecond)
          ? (data.length * 8 * 1_000) / current.rateBitsPerSecond
          : 0;
        serializedUntil = Math.max(now, serializedUntil) + serialization;
        queue.push({ at: serializedUntil + current.rttMs / 2, data });
      }
      if (Number.isFinite(current.rateBitsPerSecond) && serializedUntil - now >= current.bufferMs) {
        pause();
      }
      if (!blocked && timer === null) timer = setTimeout(flush, Math.max(0, queue[0]!.at - now));
    },
    destroy() {
      disposed = true;
      target.off("drain", onDrain);
      if (timer !== null) clearTimeout(timer);
      queue.length = 0;
    },
  };
}

export function startLinkEmulator(targetPort: number): Promise<LinkEmulator> {
  let conditions: LinkConditions = LOOPBACK;
  let connections: ConnectionBytes[] = [];
  const sockets = new Set<NodeNet.Socket>();

  const server = NodeNet.createServer((client) => {
    client.setNoDelay(true);
    const upstream = NodeNet.connect({ host: "127.0.0.1", port: targetPort });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const record: ConnectionBytes = { path: "?", downstream: 0, upstream: 0 };
    connections.push(record);
    let sawRequestLine = false;
    const up = createPipe(
      client,
      upstream,
      () => conditions,
      (bytes) => {
        record.upstream += bytes;
      },
    );
    const down = createPipe(
      upstream,
      client,
      () => conditions,
      (bytes) => {
        record.downstream += bytes;
      },
    );
    client.on("data", (chunk: Buffer) => {
      if (!sawRequestLine) {
        sawRequestLine = true;
        const line = chunk.toString("latin1", 0, Math.min(chunk.length, 256)).split("\r\n")[0];
        record.path = line?.split(" ")[1] ?? "?";
      }
      up.push(chunk);
    });
    upstream.on("data", (chunk: Buffer) => down.push(chunk));
    const teardown = () => {
      up.destroy();
      down.destroy();
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", teardown);
    upstream.on("close", teardown);
    client.on("error", teardown);
    upstream.on("error", teardown);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve({
        port: address.port,
        setConditions(next) {
          conditions = next;
        },
        snapshot: () => connections.map((entry) => ({ ...entry })),
        reset() {
          for (const entry of connections) {
            entry.downstream = 0;
            entry.upstream = 0;
          }
          connections = connections.filter(() => true);
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
