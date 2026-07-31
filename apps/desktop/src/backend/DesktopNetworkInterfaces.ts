import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface DesktopNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
  readonly netmask?: string;
  readonly mac?: string;
  readonly cidr?: string | null;
  readonly scopeid?: number;
}

export type NetworkInterfaces = Readonly<
  Record<string, readonly DesktopNetworkInterfaceInfo[] | undefined>
>;

const IPV4_OCTET_COUNT = 4;

function parseIpv4Address(address: string): readonly number[] | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== IPV4_OCTET_COUNT ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets;
}

export function isPrivateLanIpv4Address(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return false;
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function interfacePreference(interfaceName: string): number {
  const normalized = interfaceName.toLowerCase();
  if (
    /(?:local area connection\*|vethernet|hyper-v|vmware|virtualbox|docker|wsl|tailscale|zerotier|hamachi|loopback|utun|bridge|^br-|^veth)/u.test(
      normalized,
    )
  ) {
    return 2;
  }
  if (/(?:^en\d+$|^en[psox]\w*|^eth\d+$|^wl\w*|wi-?fi|wlan|ethernet)/u.test(normalized)) {
    return 0;
  }
  return 1;
}

/**
 * Picks the address users are most likely to mean by "this device on my
 * network". Node preserves OS interface order, but Windows often lists a
 * virtual hotspot or Hyper-V adapter before the active Wi-Fi adapter.
 */
export function selectPreferredLanIpv4Address(networkInterfaces: NetworkInterfaces): string | null {
  const candidates: Array<{
    readonly address: string;
    readonly interfacePreference: number;
    readonly order: number;
  }> = [];
  let order = 0;

  for (const [interfaceName, interfaceAddresses] of Object.entries(networkInterfaces)) {
    if (!interfaceAddresses) continue;
    for (const address of interfaceAddresses) {
      const currentOrder = order;
      order += 1;
      if (address.internal) continue;
      if (address.family !== "IPv4" && address.family !== 4) continue;
      if (!isPrivateLanIpv4Address(address.address)) continue;
      candidates.push({
        address: address.address,
        interfacePreference: interfacePreference(interfaceName),
        order: currentOrder,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.interfacePreference - right.interfacePreference || left.order - right.order,
  );
  return candidates[0]?.address ?? null;
}

export class DesktopNetworkInterfacesReadError extends Schema.TaggedErrorClass<DesktopNetworkInterfacesReadError>()(
  "DesktopNetworkInterfacesReadError",
  {
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop network interfaces on ${this.platform}.`;
  }
}

export class DesktopNetworkInterfaces extends Context.Service<
  DesktopNetworkInterfaces,
  {
    readonly read: Effect.Effect<NetworkInterfaces>;
  }
>()("@t3tools/desktop/backend/DesktopNetworkInterfaces") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return DesktopNetworkInterfaces.of({
    read: Effect.try({
      try: () => NodeOS.networkInterfaces(),
      catch: (cause) => new DesktopNetworkInterfacesReadError({ platform, cause }),
    }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(DesktopNetworkInterfaces, make);
