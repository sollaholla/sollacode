/* eslint-disable unicorn/require-post-message-target-origin -- Dedicated workers use transfer lists, not window target origins. */
/// <reference lib="webworker" />
import { createRemoteFrameEncoder, type RemoteFrameEncoder } from "./remoteFrameEncoder";
import type {
  RemoteFrameWorkerRequest,
  RemoteFrameWorkerResponse,
} from "./remoteFrameEncoderClient";

/**
 * Encodes remote viewers' pictures off the desktop window's main thread:
 * decoding, comparing and re-encoding a phone-sized picture takes a few
 * milliseconds each, which would otherwise come out of the app's frames.
 */
const encoders = new Map<string, RemoteFrameEncoder>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<RemoteFrameWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "drop") {
    encoders.delete(request.key);
    return;
  }
  if (request.kind === "reset") {
    encoders.get(request.key)?.reset();
    return;
  }
  let encoder = encoders.get(request.key);
  if (encoder === undefined) {
    encoder = createRemoteFrameEncoder();
    encoders.set(request.key, encoder);
  }
  encoder.encode(request.input).then(
    (result) => scope.postMessage({ id: request.id, result } satisfies RemoteFrameWorkerResponse),
    (error: unknown) =>
      scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies RemoteFrameWorkerResponse),
  );
});
