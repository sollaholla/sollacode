import { describe, expect, it } from "vite-plus/test";

import {
  decodeMediaAck,
  decodeMediaPacket,
  encodeMediaAck,
  encodeMediaPacket,
  MEDIA_PACKET_HEADER_BYTES,
  peekMediaPacket,
} from "./mediaPacket.ts";

const payload = new Uint8Array([1, 2, 3, 4, 5]);

describe("media packets", () => {
  it("round-trips a key frame with its decoder config", () => {
    const description = new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xff]);
    const bytes = encodeMediaPacket({
      key: true,
      epoch: 7,
      sequence: 4_000_000_000,
      capturedAt: 1_761_000_000_123.5,
      timestamp: 123_456_789,
      config: {
        codec: "avc1.640033",
        codedWidth: 1_170,
        codedHeight: 732,
        sourceWidth: 2_560,
        sourceHeight: 1_600,
        description,
      },
      payload,
    });
    const packet = decodeMediaPacket(bytes);
    expect(packet).not.toBeNull();
    expect(packet!.key).toBe(true);
    expect(packet!.epoch).toBe(7);
    expect(packet!.sequence).toBe(4_000_000_000);
    expect(packet!.capturedAt).toBe(1_761_000_000_123.5);
    expect(packet!.timestamp).toBe(123_456_789);
    expect(packet!.config).toEqual({
      codec: "avc1.640033",
      codedWidth: 1_170,
      codedHeight: 732,
      sourceWidth: 2_560,
      sourceHeight: 1_600,
      description,
    });
    expect([...packet!.payload]).toEqual([...payload]);
  });

  it("keeps inter frames to the fixed header plus payload", () => {
    const bytes = encodeMediaPacket({
      key: false,
      epoch: 1,
      sequence: 2,
      capturedAt: 0,
      timestamp: 0,
      payload,
    });
    expect(bytes.length).toBe(MEDIA_PACKET_HEADER_BYTES + payload.length);
    const packet = decodeMediaPacket(bytes)!;
    expect(packet.config).toBeUndefined();
    expect(packet.key).toBe(false);
  });

  it("lets the relay route from the header alone", () => {
    const bytes = encodeMediaPacket({
      key: true,
      epoch: 3,
      sequence: 9,
      capturedAt: 0,
      timestamp: 0,
      payload,
    });
    expect(peekMediaPacket(bytes)).toEqual({ kind: "video", key: true, epoch: 3, sequence: 9 });
    // A view into a larger buffer, as a WebSocket message may be.
    const framed = new Uint8Array(bytes.length + 8);
    framed.set(bytes, 8);
    expect(peekMediaPacket(framed.subarray(8))?.sequence).toBe(9);
  });

  it("rejects anything that is not a media packet", () => {
    expect(peekMediaPacket(new Uint8Array(4))).toBeNull();
    expect(decodeMediaPacket(new Uint8Array(MEDIA_PACKET_HEADER_BYTES))).toBeNull();
    const bytes = encodeMediaPacket({
      key: true,
      epoch: 0,
      sequence: 0,
      capturedAt: 0,
      timestamp: 0,
      config: { codec: "vp8", codedWidth: 2, codedHeight: 2, sourceWidth: 2, sourceHeight: 2 },
      payload,
    });
    // A config length that runs past the end of the message.
    const truncated = bytes.slice(0, MEDIA_PACKET_HEADER_BYTES + 3);
    expect(decodeMediaPacket(truncated)).toBeNull();
  });

  it("refuses to frame values that would not survive the wire", () => {
    expect(() =>
      encodeMediaPacket({
        key: true,
        epoch: 0,
        sequence: 0,
        capturedAt: 0,
        timestamp: 0,
        config: {
          codec: "avc1.640033",
          codedWidth: 70_000,
          codedHeight: 2,
          sourceWidth: 2,
          sourceHeight: 2,
        },
        payload,
      }),
    ).toThrow(RangeError);
  });

  it("round-trips acknowledgements and ignores other bytes", () => {
    expect(decodeMediaAck(encodeMediaAck(123_456))).toBe(123_456);
    expect(decodeMediaAck(new Uint8Array([0x41, 0, 0]))).toBeNull();
    expect(decodeMediaAck(new Uint8Array([0x53, 0, 0, 0, 1]))).toBeNull();
  });
});
