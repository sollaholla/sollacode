import {
  createRemoteFrameEncoder,
  type RemoteFrameEncodeInput,
} from "../../apps/web/src/components/preview/remoteFrames/remoteFrameEncoder.ts";
import { compareCompression } from "./compressionDiagnostic.ts";
import "./media-renderer.ts";

// The production browser encoder runs in an isolated Electron renderer. Only
// its IPC adapter differs from the app's worker adapter.
const encoders = new Map<string, ReturnType<typeof createRemoteFrameEncoder>>();
Object.assign(globalThis, {
  previewBenchEncoder: {
    compareCompression,
    encode: (key: string, input: RemoteFrameEncodeInput) => {
      let encoder = encoders.get(key);
      if (!encoder) {
        encoder = createRemoteFrameEncoder();
        encoders.set(key, encoder);
      }
      return encoder.encode(input);
    },
    reset: (key: string) => encoders.get(key)?.reset(),
    drop: (key: string) => encoders.delete(key),
  },
});
