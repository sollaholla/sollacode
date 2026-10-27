// @effect-diagnostics nodeBuiltinImport:off - Talks HTTP/2 to the emulator's local control port.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp2 from "node:http2";
import * as NodePath from "node:path";

import { parseIni } from "./androidEmulators.ts";

/**
 * A running emulator, from the discovery file it writes on start
 * (`pid_<pid>.ini`). Android Studio finds running emulators the same way.
 */
export interface EmulatorDiscovery {
  readonly pid: number;
  readonly avdName: string;
  readonly serial: string;
  readonly grpcPort: number | null;
  readonly grpcToken: string | null;
}

/** Where emulators write their discovery files on each platform. */
export function emulatorDiscoveryDirs(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): string[] {
  if (input.platform === "darwin") {
    return [NodePath.join(input.home, "Library", "Caches", "TemporaryItems", "avd", "running")];
  }
  if (input.platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA ?? NodePath.join(input.home, "AppData", "Local");
    return [NodePath.win32.join(localAppData, "Temp", "avd", "running")];
  }
  const dirs: string[] = [];
  if (input.env.XDG_RUNTIME_DIR)
    dirs.push(NodePath.join(input.env.XDG_RUNTIME_DIR, "avd", "running"));
  dirs.push(NodePath.join("/tmp", `android-${input.env.USER ?? "user"}`, "avd", "running"));
  return dirs;
}

export function parseEmulatorDiscovery(fileName: string, text: string): EmulatorDiscovery | null {
  const pid = Number(/^pid_(\d+)\.ini$/u.exec(fileName)?.[1]);
  const values = parseIni(text);
  const avdName = values.get("avd.id");
  const consolePort = Number(values.get("port.serial"));
  if (!pid || !avdName || !consolePort) return null;
  const grpcPort = Number(values.get("grpc.port"));
  return {
    pid,
    avdName,
    serial: `emulator-${consolePort}`,
    grpcPort: grpcPort > 0 ? grpcPort : null,
    grpcToken: values.get("grpc.token") || null,
  };
}

export async function readEmulatorDiscovery(
  dirs: ReadonlyArray<string>,
  isAlive: (pid: number) => boolean,
): Promise<EmulatorDiscovery[]> {
  const found: EmulatorDiscovery[] = [];
  for (const dir of dirs) {
    for (const entry of await NodeFSP.readdir(dir).catch(() => [] as string[])) {
      if (!entry.startsWith("pid_") || !entry.endsWith(".ini")) continue;
      const text = await NodeFSP.readFile(NodePath.join(dir, entry), "utf8").catch(() => null);
      const discovery = text === null ? null : parseEmulatorDiscovery(entry, text);
      if (discovery && isAlive(discovery.pid)) found.push(discovery);
    }
  }
  return found;
}

// ---- Minimal protobuf for the few EmulatorController messages used --------

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  while (remaining > 127) {
    bytes.push((remaining % 128) | 128);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function intField(fieldNumber: number, value: number): number[] {
  return value === 0 ? [] : [...varint(fieldNumber * 8), ...varint(value)];
}

function bytesField(fieldNumber: number, bytes: ReadonlyArray<number>): number[] {
  return [...varint(fieldNumber * 8 + 2), ...varint(bytes.length), ...bytes];
}

/** Top-level fields of one message: varints as numbers, length-delimited as buffers. */
export function decodeProtobuf(buffer: Buffer): Map<number, number | Buffer> {
  const fields = new Map<number, number | Buffer>();
  let offset = 0;
  const readVarint = () => {
    let result = 0;
    let scale = 1;
    for (;;) {
      if (offset >= buffer.length) throw new Error("Truncated protobuf varint.");
      const byte = buffer[offset++]!;
      result += (byte & 127) * scale;
      if ((byte & 128) === 0) return result;
      scale *= 128;
    }
  };
  while (offset < buffer.length) {
    const tag = readVarint();
    const fieldNumber = Math.floor(tag / 8);
    switch (tag % 8) {
      case 0:
        fields.set(fieldNumber, readVarint());
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        const length = readVarint();
        fields.set(fieldNumber, buffer.subarray(offset, offset + length));
        offset += length;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw new Error("Unsupported protobuf wire type.");
    }
  }
  return fields;
}

/** Screen rotation as the emulator reports it: quarter turns counterclockwise. */
export type EmulatorRotation = 0 | 1 | 2 | 3;

export interface EmulatorScreenshot {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly rotation: EmulatorRotation;
}

export function encodeScreenshotRequest(width: number, height: number): Buffer {
  // ImageFormat { format = PNG (0), width = 3, height = 4 }
  return Buffer.from([...intField(3, width), ...intField(4, height)]);
}

export function decodeScreenshot(message: Buffer): EmulatorScreenshot | null {
  const image = decodeProtobuf(message);
  const png = image.get(4);
  const format = image.get(1);
  if (!Buffer.isBuffer(png) || !Buffer.isBuffer(format)) return null;
  const formatFields = decodeProtobuf(format);
  const rotationMessage = formatFields.get(2);
  const rotation = Buffer.isBuffer(rotationMessage)
    ? Number(decodeProtobuf(rotationMessage).get(1) ?? 0)
    : 0;
  return {
    png,
    width: Number(formatFields.get(3) ?? 0),
    height: Number(formatFields.get(4) ?? 0),
    rotation: (rotation >= 0 && rotation <= 3 ? rotation : 0) as EmulatorRotation,
  };
}

export function encodeTouchEvent(x: number, y: number, down: boolean): Buffer {
  // TouchEvent { touches = [Touch { x = 1, y = 2, identifier = 3, pressure = 4 }] }
  const touch = [...intField(1, x), ...intField(2, y), ...intField(4, down ? 1 : 0)];
  return Buffer.from(bytesField(1, touch));
}

/**
 * Maps a point given as fractions of the picture on screen to the emulator's
 * physical panel, which stays in its natural portrait orientation.
 */
export function physicalPoint(input: {
  readonly fx: number;
  readonly fy: number;
  readonly panelWidth: number;
  readonly panelHeight: number;
  readonly rotation: EmulatorRotation;
}): { x: number; y: number } {
  const fx = Math.min(1, Math.max(0, input.fx));
  const fy = Math.min(1, Math.max(0, input.fy));
  const w = input.panelWidth - 1;
  const h = input.panelHeight - 1;
  switch (input.rotation) {
    case 1:
      return { x: Math.round((1 - fy) * w), y: Math.round(fx * h) };
    case 2:
      return { x: Math.round((1 - fx) * w), y: Math.round((1 - fy) * h) };
    case 3:
      return { x: Math.round(fy * w), y: Math.round((1 - fx) * h) };
    default:
      return { x: Math.round(fx * w), y: Math.round(fy * h) };
  }
}

const GRPC_SERVICE = "/android.emulation.control.EmulatorController";

/** One emulator's gRPC control port, over a single reused HTTP/2 connection. */
export class EmulatorControl {
  private session: NodeHttp2.ClientHttp2Session | null = null;
  private readonly port: number;
  private readonly token: string;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
  }

  private connect(): NodeHttp2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = NodeHttp2.connect(`http://127.0.0.1:${this.port}`);
    session.on("error", () => session.destroy());
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });
    this.session = session;
    return session;
  }

  call(method: string, body: Buffer, timeoutMs = 10_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const request = this.connect().request({
        ":method": "POST",
        ":path": `${GRPC_SERVICE}/${method}`,
        "content-type": "application/grpc",
        te: "trailers",
        authorization: `Bearer ${this.token}`,
      });
      request.setTimeout(timeoutMs, () => request.close(NodeHttp2.constants.NGHTTP2_CANCEL));
      const chunks: Buffer[] = [];
      let status: string | null = null;
      let message = "";
      request.on("response", (headers) => {
        // Errors without a body arrive as a trailers-only response.
        if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"]);
      });
      request.on("trailers", (trailers) => {
        status = String(trailers["grpc-status"] ?? status ?? "");
        message = String(trailers["grpc-message"] ?? "");
      });
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("error", reject);
      request.on("close", () => {
        if (status !== "0") {
          reject(
            new Error(
              `Emulator ${method} failed${message ? `: ${decodeURIComponent(message)}` : ""}.`,
            ),
          );
          return;
        }
        const payload = Buffer.concat(chunks);
        resolve(
          payload.length >= 5 ? payload.subarray(5, 5 + payload.readUInt32BE(1)) : Buffer.alloc(0),
        );
      });
      const header = Buffer.alloc(5);
      header.writeUInt32BE(body.length, 1);
      request.end(Buffer.concat([header, body]));
    });
  }

  async screenshot(width: number, height: number): Promise<EmulatorScreenshot> {
    const shot = decodeScreenshot(
      await this.call("getScreenshot", encodeScreenshotRequest(width, height)),
    );
    if (shot === null) throw new Error("The emulator returned no screen yet.");
    return shot;
  }

  touch(x: number, y: number, down: boolean): Promise<Buffer> {
    return this.call("sendTouch", encodeTouchEvent(x, y, down));
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
