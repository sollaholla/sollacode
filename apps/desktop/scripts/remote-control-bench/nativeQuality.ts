/** One diagnostic clone of the exact frame submitted to the native encoder. */
export function captureNextEncodedFrame(prototype: Pick<VideoEncoder, "encode">) {
  const original = prototype.encode;
  let captured: VideoFrame | null = null;
  const restore = () => {
    if (prototype.encode === observedEncode) prototype.encode = original;
  };
  function observedEncode(
    this: VideoEncoder,
    frame: VideoFrame,
    options?: VideoEncoderEncodeOptions,
  ) {
    const clone = frame.clone();
    try {
      original.call(this, frame, options);
      captured = clone;
      restore();
    } catch (error) {
      clone.close();
      restore();
      throw error;
    }
  }
  prototype.encode = observedEncode;
  return {
    /** Transfers clone ownership to the caller, which must close it. */
    take() {
      const frame = captured;
      captured = null;
      return frame;
    },
    stop() {
      restore();
      captured?.close();
      captured = null;
    },
  };
}

export interface NativeQualityCapture {
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly png: string;
}
