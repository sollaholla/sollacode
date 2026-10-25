import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createVideoCanvasRenderer } from "./videoCanvasRenderer.ts";
import type { MediaPacket } from "@t3tools/shared/mediaPacket";

const config = {
  codec: "vp8",
  codedWidth: 640,
  codedHeight: 480,
  sourceWidth: 1280,
  sourceHeight: 960,
};
const packet = (overrides: Partial<MediaPacket> = {}): MediaPacket => ({
  kind: "video",
  key: true,
  epoch: 1,
  sequence: 1,
  capturedAt: 0,
  timestamp: 1,
  ...(overrides.key === false ? {} : { config }),
  payload: new Uint8Array([1]),
  ...overrides,
});
function setup() {
  const close = vi.fn();
  const reset = vi.fn();
  const configure = vi.fn();
  const decode = vi.fn();
  const decoder = { state: "configured", close, reset, configure, decode, decodeQueueSize: 0 };
  vi.stubGlobal("VideoDecoder", function () {
    return decoder;
  });
  vi.stubGlobal("EncodedVideoChunk", function (init: unknown) {
    return { init };
  });
  const onKeyframeNeeded = vi.fn();
  const onFatal = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
  } as unknown as HTMLCanvasElement;
  const renderer = createVideoCanvasRenderer({ canvas, onKeyframeNeeded, onFatal });
  return { renderer, decoder, onKeyframeNeeded, onFatal };
}
afterEach(() => vi.unstubAllGlobals());
describe("video decoder lifecycle", () => {
  it("closes a decoder that throws synchronously and falls back after repeated failures", () => {
    const { renderer, decoder, onFatal } = setup();
    decoder.configure.mockImplementation(() => {
      throw new Error("unsupported");
    });
    for (let index = 0; index < 3; index++) renderer.push(packet());
    expect(decoder.close).toHaveBeenCalledTimes(3);
    expect(onFatal).toHaveBeenCalledOnce();
    renderer.dispose();
  });
  it("discards decoder backlog and resumes only at a keyframe", () => {
    const { renderer, decoder, onKeyframeNeeded } = setup();
    renderer.push(packet());
    decoder.decodeQueueSize = 4;
    renderer.push(packet({ key: false, sequence: 2 }));
    expect(decoder.reset).toHaveBeenCalledOnce();
    expect(onKeyframeNeeded).toHaveBeenCalledOnce();
    decoder.decodeQueueSize = 0;
    renderer.push(packet({ key: false, sequence: 3 }));
    expect(decoder.decode).toHaveBeenCalledOnce();
    renderer.push(packet({ sequence: 4 }));
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });
  it("reconfigures on encoder epoch even if dimensions and codec are unchanged", () => {
    const { renderer, decoder } = setup();
    renderer.push(packet());
    renderer.push(packet({ epoch: 2, sequence: 2 }));
    expect(decoder.configure).toHaveBeenCalledTimes(2);
    renderer.dispose();
    renderer.dispose();
    expect(decoder.close).toHaveBeenCalledOnce();
  });
});
