/**
 * Binary framing for the media channel (`/ws/media`).
 *
 * One WebSocket binary message is one encoded media chunk with a fixed
 * big-endian header in front:
 *
 *   0  u8   magic 0x53 ("S")
 *   1  u8   version (1)
 *   2  u8   flags: bit 0 key frame, bit 1 config block present
 *   3  u8   kind: 1 video
 *   4  u32  epoch - encoder generation; bumps on every reconfigure
 *   8  u32  sequence - per publisher connection, strictly increasing
 *   12 f64  capturedAt - publisher clock, epoch milliseconds
 *   20 f64  timestamp - the chunk's media timestamp, microseconds
 *   28 u16  config length (0 when absent)
 *   30 ...  config block, then the encoded payload
 *
 * The config block carries what a decoder needs to start at this chunk:
 *
 *   u8 codec length, codec (ASCII), u16 coded width, u16 coded height,
 *   u16 source width, u16 source height, u16 description length, description
 *
 * Every key frame repeats it, so a subscriber can join at any key frame
 * without the relay remembering anything. The relay itself only ever reads
 * the first 12 bytes (`peekMediaPacket`).
 *
 * The subscriber's only binary message is an acknowledgement:
 *
 *   0 u8 0x41 ("A"), 1 u32 sequence
 */

export const MEDIA_PACKET_MAGIC = 0x53;
export const MEDIA_PACKET_VERSION = 1;
export const MEDIA_PACKET_HEADER_BYTES = 30;
export const MEDIA_ACK_MAGIC = 0x41;
export const MEDIA_ACK_BYTES = 5;
/** A WebSocket message on the media channel never exceeds this. */
export const MEDIA_PACKET_MAX_BYTES = 8 * 1024 * 1024;

const FLAG_KEY = 1;
const FLAG_CONFIG = 2;

export type MediaPacketKind = "video";

export interface MediaVideoConfig {
  /** WebCodecs codec string, e.g. `avc1.640033`. */
  readonly codec: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** Size of the picture the encoder was fed before scaling. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** avcC / hvcC record; absent for Annex B and VP8. */
  readonly description?: Uint8Array;
}

export interface MediaPacketHeader {
  readonly kind: MediaPacketKind;
  readonly key: boolean;
  readonly epoch: number;
  readonly sequence: number;
}

export interface MediaPacket extends MediaPacketHeader {
  readonly capturedAt: number;
  readonly timestamp: number;
  readonly config?: MediaVideoConfig;
  readonly payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function asUint16(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${field} must fit in 16 bits`);
  }
  return value;
}

function encodeConfig(config: MediaVideoConfig): Uint8Array {
  const codec = textEncoder.encode(config.codec);
  if (codec.length === 0 || codec.length > 0xff) throw new RangeError("codec string length");
  const description = config.description ?? new Uint8Array(0);
  const bytes = new Uint8Array(1 + codec.length + 10 + description.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = codec.length;
  bytes.set(codec, 1);
  let offset = 1 + codec.length;
  view.setUint16(offset, asUint16(config.codedWidth, "codedWidth"));
  view.setUint16(offset + 2, asUint16(config.codedHeight, "codedHeight"));
  view.setUint16(offset + 4, asUint16(config.sourceWidth, "sourceWidth"));
  view.setUint16(offset + 6, asUint16(config.sourceHeight, "sourceHeight"));
  view.setUint16(offset + 8, asUint16(description.length, "description length"));
  offset += 10;
  bytes.set(description, offset);
  return bytes;
}

function decodeConfig(bytes: Uint8Array): MediaVideoConfig | null {
  if (bytes.length < 1) return null;
  const codecLength = bytes[0]!;
  if (codecLength === 0 || bytes.length < 1 + codecLength + 10) return null;
  const codec = textDecoder.decode(bytes.subarray(1, 1 + codecLength));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = 1 + codecLength;
  const descriptionLength = view.getUint16(offset + 8);
  if (bytes.length !== offset + 10 + descriptionLength) return null;
  const description = bytes.slice(offset + 10, offset + 10 + descriptionLength);
  return {
    codec,
    codedWidth: view.getUint16(offset),
    codedHeight: view.getUint16(offset + 2),
    sourceWidth: view.getUint16(offset + 4),
    sourceHeight: view.getUint16(offset + 6),
    ...(descriptionLength > 0 ? { description } : {}),
  };
}

export function encodeMediaPacket(
  packet: Omit<MediaPacket, "kind"> & { kind?: "video" },
): Uint8Array<ArrayBuffer> {
  const config = packet.config ? encodeConfig(packet.config) : null;
  const configLength = config?.length ?? 0;
  const total = MEDIA_PACKET_HEADER_BYTES + configLength + packet.payload.length;
  if (total > MEDIA_PACKET_MAX_BYTES) throw new RangeError("media packet too large");
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = MEDIA_PACKET_MAGIC;
  bytes[1] = MEDIA_PACKET_VERSION;
  bytes[2] = (packet.key ? FLAG_KEY : 0) | (config ? FLAG_CONFIG : 0);
  bytes[3] = 1;
  view.setUint32(4, packet.epoch >>> 0);
  view.setUint32(8, packet.sequence >>> 0);
  view.setFloat64(12, packet.capturedAt);
  view.setFloat64(20, packet.timestamp);
  view.setUint16(28, configLength);
  if (config) bytes.set(config, MEDIA_PACKET_HEADER_BYTES);
  bytes.set(packet.payload, MEDIA_PACKET_HEADER_BYTES + configLength);
  return bytes;
}

/** Just enough of the header to route a packet, without copying it. */
export function peekMediaPacket(bytes: Uint8Array): MediaPacketHeader | null {
  if (
    bytes.length < MEDIA_PACKET_HEADER_BYTES ||
    bytes[0] !== MEDIA_PACKET_MAGIC ||
    bytes[1] !== MEDIA_PACKET_VERSION ||
    bytes[3] !== 1
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    kind: "video",
    key: (bytes[2]! & FLAG_KEY) !== 0,
    epoch: view.getUint32(4),
    sequence: view.getUint32(8),
  };
}

export function decodeMediaPacket(bytes: Uint8Array): MediaPacket | null {
  const header = peekMediaPacket(bytes);
  if (!header) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const configLength = view.getUint16(28);
  if (bytes.length < MEDIA_PACKET_HEADER_BYTES + configLength) return null;
  const hasConfig = (bytes[2]! & FLAG_CONFIG) !== 0;
  if (hasConfig !== configLength > 0) return null;
  const config = hasConfig
    ? decodeConfig(
        bytes.subarray(MEDIA_PACKET_HEADER_BYTES, MEDIA_PACKET_HEADER_BYTES + configLength),
      )
    : undefined;
  if (config === null) return null;
  return {
    ...header,
    capturedAt: view.getFloat64(12),
    timestamp: view.getFloat64(20),
    ...(config ? { config } : {}),
    payload: bytes.subarray(MEDIA_PACKET_HEADER_BYTES + configLength),
  };
}

export function encodeMediaAck(sequence: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(MEDIA_ACK_BYTES);
  bytes[0] = MEDIA_ACK_MAGIC;
  new DataView(bytes.buffer).setUint32(1, sequence >>> 0);
  return bytes;
}

export function decodeMediaAck(bytes: Uint8Array): number | null {
  if (bytes.length !== MEDIA_ACK_BYTES || bytes[0] !== MEDIA_ACK_MAGIC) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
}
