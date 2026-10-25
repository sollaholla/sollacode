/* eslint-disable unicorn/require-post-message-target-origin -- Dedicated workers use transfer lists, not window target origins. */
import type { RemoteFrameEncodeInput, RemoteFrameEncoded } from "./remoteFrameEncoder";

export type RemoteFrameWorkerRequest =
  | {
      readonly kind: "encode";
      readonly id: number;
      readonly key: string;
      readonly input: RemoteFrameEncodeInput;
    }
  | { readonly kind: "reset"; readonly key: string }
  | { readonly kind: "drop"; readonly key: string };

export type RemoteFrameWorkerResponse =
  | { readonly id: number; readonly result: RemoteFrameEncoded }
  | { readonly id: number; readonly error: string };

export interface RemoteFrameEncoderPool {
  readonly encode: (key: string, input: RemoteFrameEncodeInput) => Promise<RemoteFrameEncoded>;
  /** The next picture for `key` goes out whole. */
  readonly reset: (key: string) => void;
  /** Forgets `key`'s last picture for good (its tab is no longer watched). */
  readonly drop: (key: string) => void;
  readonly dispose: () => void;
}

/**
 * One worker that encodes every watched tab's pictures, created on first use
 * so a desktop nobody watches remotely never starts it.
 */
export function createRemoteFrameEncoderPool(): RemoteFrameEncoderPool {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      readonly resolve: (result: RemoteFrameEncoded) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  const ensureWorker = () => {
    if (worker !== null) return worker;
    const created = new Worker(new URL("./remoteFrameEncoder.worker.ts", import.meta.url), {
      type: "module",
    });
    created.addEventListener("message", (event: MessageEvent<RemoteFrameWorkerResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if ("error" in response) entry.reject(new Error(response.error));
      else entry.resolve(response.result);
    });
    created.addEventListener("error", (event) => {
      for (const entry of pending.values()) entry.reject(new Error(event.message));
      pending.clear();
      created.terminate();
      if (worker === created) worker = null;
    });
    worker = created;
    return created;
  };
  const post = (request: RemoteFrameWorkerRequest) => ensureWorker().postMessage(request);
  return {
    encode: (key, input) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        post({ kind: "encode", id, key, input });
      }),
    reset: (key) => {
      if (worker !== null) post({ kind: "reset", key });
    },
    drop: (key) => {
      if (worker !== null) post({ kind: "drop", key });
    },
    dispose: () => {
      worker?.terminate();
      worker = null;
      for (const entry of pending.values()) entry.reject(new Error("The encoder was closed."));
      pending.clear();
    },
  };
}
