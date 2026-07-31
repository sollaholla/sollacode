import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, expect, vi } from "vite-plus/test";

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn(),
}));

vi.mock("node:os", () => ({
  networkInterfaces: networkInterfacesMock,
}));

import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";

const TestLayer = DesktopNetworkInterfaces.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

describe("DesktopNetworkInterfaces", () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset();
  });

  it.effect("reads network interfaces through the service", () => {
    const interfaces = {
      en0: [
        {
          address: "192.168.1.10",
          family: "IPv4",
          internal: false,
        },
      ],
    };
    networkInterfacesMock.mockReturnValueOnce(interfaces);

    return Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      assert.strictEqual(yield* service.read, interfaces);
    }).pipe(Effect.provide(TestLayer));
  });

  it.effect("preserves network interface read failures as structured defects", () => {
    const cause = new Error("network interface probe failed");
    networkInterfacesMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const service = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
      const exit = yield* Effect.exit(service.read);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopNetworkInterfaces.DesktopNetworkInterfacesReadError);
        assert.equal(error.platform, "linux");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, "Failed to read desktop network interfaces on linux.");
      }
    }).pipe(Effect.provide(TestLayer));
  });

  it("prefers a physical Wi-Fi adapter over Windows virtual adapters", () => {
    expect(
      DesktopNetworkInterfaces.selectPreferredLanIpv4Address({
        "Local Area Connection* 10": [
          {
            address: "192.168.137.1",
            family: "IPv4",
            internal: false,
          },
        ],
        "vEthernet (Default Switch)": [
          {
            address: "172.21.144.1",
            family: "IPv4",
            internal: false,
          },
        ],
        "Wi-Fi": [
          {
            address: "10.2.1.243",
            family: "IPv4",
            internal: false,
          },
        ],
      }),
    ).toBe("10.2.1.243");
  });

  it("falls back to an unknown private adapter and rejects public addresses", () => {
    expect(
      DesktopNetworkInterfaces.selectPreferredLanIpv4Address({
        mystery0: [
          {
            address: "8.8.8.8",
            family: "IPv4",
            internal: false,
          },
          {
            address: "172.20.4.9",
            family: "IPv4",
            internal: false,
          },
        ],
      }),
    ).toBe("172.20.4.9");
  });
});
