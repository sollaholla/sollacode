import { describe, expect, it } from "vite-plus/test";

import {
  decodeProtobuf,
  decodeScreenshot,
  encodeScreenshotRequest,
  encodeTouchEvent,
  parseEmulatorDiscovery,
  physicalPoint,
} from "./androidEmulatorControl.ts";

describe("emulator control", () => {
  it("reads the discovery file a running emulator writes", () => {
    expect(
      parseEmulatorDiscovery(
        "pid_55256.ini",
        "avd.id=Pixel_10_Pro\nport.serial=5554\ngrpc.port=8554\ngrpc.token=secret\n",
      ),
    ).toEqual({
      pid: 55256,
      avdName: "Pixel_10_Pro",
      serial: "emulator-5554",
      grpcPort: 8554,
      grpcToken: "secret",
    });
    expect(parseEmulatorDiscovery("pid_1.ini", "avd.id=Old\nport.serial=5556\n")).toMatchObject({
      grpcPort: null,
      grpcToken: null,
    });
    expect(parseEmulatorDiscovery("notes.ini", "avd.id=A\nport.serial=5554\n")).toBeNull();
  });

  it("encodes the requests the emulator expects", () => {
    expect([...encodeScreenshotRequest(640, 1428)]).toEqual([0x18, 0x80, 0x05, 0x20, 0x94, 0x0b]);
    const touch = decodeProtobuf(encodeTouchEvent(10, 300, true));
    const point = decodeProtobuf(touch.get(1) as Buffer);
    expect([point.get(1), point.get(2), point.get(4)]).toEqual([10, 300, 1]);
    // Lifting the finger sends pressure 0, which protobuf leaves out.
    expect(
      decodeProtobuf(decodeProtobuf(encodeTouchEvent(10, 300, false)).get(1) as Buffer).has(4),
    ).toBe(false);
  });

  it("decodes a screenshot reply with its size and rotation", () => {
    // Image { format = ImageFormat { rotation = Rotation { rotation = 1 }, width = 4, height = 2 }, image = [1, 2] }
    const format = [0x12, 0x02, 0x08, 0x01, 0x18, 0x04, 0x20, 0x02];
    const message = Buffer.from([0x0a, format.length, ...format, 0x22, 0x02, 0x01, 0x02]);
    expect(decodeScreenshot(message)).toEqual({
      png: Buffer.from([1, 2]),
      width: 4,
      height: 2,
      rotation: 1,
    });
    expect(decodeScreenshot(Buffer.from([0x28, 0x01]))).toBeNull();
  });

  it("maps a point on the picture to the portrait panel for every rotation", () => {
    const panel = { panelWidth: 101, panelHeight: 201 };
    const at = (fx: number, fy: number, rotation: 0 | 1 | 2 | 3) =>
      physicalPoint({ fx, fy, rotation, ...panel });
    expect(at(0.25, 0.5, 0)).toEqual({ x: 25, y: 100 });
    expect(at(0.25, 0.5, 2)).toEqual({ x: 75, y: 100 });
    // Turned a quarter: the picture's left edge is the panel's top or bottom.
    expect(at(0, 0.25, 3)).toEqual({ x: 25, y: 200 });
    expect(at(0, 0.25, 1)).toEqual({ x: 75, y: 0 });
    expect(at(2, -1, 0)).toEqual({ x: 100, y: 0 });
  });
});
