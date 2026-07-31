// @effect-diagnostics nodeBuiltinImport:off - Nearby discovery uses Node UDP and a private HTTP trust handshake.
// @effect-diagnostics globalTimers:off - Socket recovery and advertisements live for the desktop process lifetime.
// @effect-diagnostics globalTimersInEffect:off - Socket callbacks and pending HTTP responses require cancellable Node timers.
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalFetchInEffect:off - Pairing targets are dynamically discovered private-LAN origins.
// @effect-diagnostics globalFetch:off - Environment identity is fetched from the locally hosted descriptor.
// @effect-diagnostics preferSchemaOverJson:off - JSON is confined to the versioned private-LAN wire envelope.
import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type DesktopLanDiscoveryIssue,
  type DesktopLanDiscoveryState,
  type DesktopLanPairingApprovedEvent,
  type DesktopLanPairingCompletionInput,
  type DesktopLanPairingRequestInput,
  type DesktopLanPairingRequestResult,
  type DesktopLanPeer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopNetworkInterfaces from "../backend/DesktopNetworkInterfaces.ts";

const LAN_DISCOVERY_PORT = 37_731;
const LAN_ADVERTISEMENT_INTERVAL_MS = 2_000;
const LAN_PEER_STALE_AFTER_MS = 8_000;
const LAN_DISCOVERY_RETRY_INTERVAL_MS = 5_000;
const LAN_PAIRING_TIMEOUT_MS = 120_000;
const LAN_PAIRING_BODY_MAX_BYTES = 64 * 1024;
const LAN_ENVIRONMENT_DESCRIPTOR_TIMEOUT_MS = 3_000;

const LanAdvertisement = Schema.Struct({
  type: Schema.Literal("solla-code-lan"),
  version: Schema.Literal(1),
  instanceId: Schema.String,
  environmentId: Schema.optionalKey(EnvironmentId),
  label: Schema.String,
  backendUrl: Schema.String,
  pairingPort: Schema.Int,
});
type LanAdvertisement = typeof LanAdvertisement.Type;
const decodeLanAdvertisement = Schema.decodeUnknownOption(LanAdvertisement);
const decodeEnvironmentDescriptor = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor);

const IncomingLanPairingRequest = Schema.Struct({
  requestId: Schema.String,
  instanceId: Schema.String,
  label: Schema.String,
  initiatorPairingUrl: Schema.String,
});
type IncomingLanPairingRequest = typeof IncomingLanPairingRequest.Type;
const decodeIncomingLanPairingRequest = Schema.decodeUnknownOption(IncomingLanPairingRequest);

function ipv4ToInteger(address: string): number | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function integerToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

/**
 * Limited broadcast (`255.255.255.255`) can leave Windows through a virtual
 * hotspot adapter. Sending each subnet's directed broadcast lets the routing
 * table choose the matching physical adapter instead.
 */
export function lanBroadcastAddresses(
  networkInterfaces: ReturnType<typeof NodeOS.networkInterfaces>,
): ReadonlyArray<string> {
  const broadcasts = new Set<string>();
  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;
    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!DesktopNetworkInterfaces.isPrivateLanIpv4Address(address.address)) continue;
      const addressInteger = ipv4ToInteger(address.address);
      const netmaskInteger = ipv4ToInteger(address.netmask);
      if (addressInteger === null || netmaskInteger === null) continue;
      broadcasts.add(integerToIpv4((addressInteger | ~netmaskInteger) >>> 0));
    }
  }
  return [...broadcasts];
}

interface InternalLanPeer extends DesktopLanPeer {
  readonly pairingOrigin: string;
}

interface PendingIncomingPairing {
  readonly response: NodeHttp.ServerResponse;
  readonly timeout: NodeJS.Timeout;
}

interface NetworkResources {
  readonly httpServer: NodeHttp.Server;
}

export class DesktopLanPairingError extends Schema.TaggedErrorClass<DesktopLanPairingError>()(
  "DesktopLanPairingError",
  {
    operation: Schema.Literals([
      "start-discovery",
      "list-peers",
      "request-pairing",
      "complete-pairing",
      "read-request",
    ]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DesktopLanDiscovery extends Context.Service<
  DesktopLanDiscovery,
  {
    readonly listPeers: Effect.Effect<ReadonlyArray<DesktopLanPeer>>;
    readonly getState: Effect.Effect<DesktopLanDiscoveryState>;
    readonly requestPairing: (
      input: DesktopLanPairingRequestInput,
    ) => Effect.Effect<DesktopLanPairingRequestResult, DesktopLanPairingError>;
    readonly completePairing: (
      input: DesktopLanPairingCompletionInput,
    ) => Effect.Effect<void, DesktopLanPairingError>;
  }
>()("@t3tools/desktop/network/DesktopLanDiscovery") {}

export function isPrivateLanAddress(rawAddress: string): boolean {
  const address = rawAddress.replace(/^::ffff:/u, "").toLowerCase();
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  if (address.startsWith("169.254.")) return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) {
    return true;
  }
  const parts = address.split(".");
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (first === 172 && second >= 16 && second <= 31) return true;
  return first === 100 && second >= 64 && second <= 127;
}

function peerBackendUrl(
  advertisement: LanAdvertisement,
  remote: NodeDgram.RemoteInfo,
): string | null {
  try {
    const url = new URL(advertisement.backendUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hostname = remote.address;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function respondJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > LAN_PAIRING_BODY_MAX_BYTES) {
      throw new Error("Nearby pairing request was too large.");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function closeServer(server: NodeHttp.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function closeSocket(socket: NodeDgram.Socket | null): Promise<void> {
  return new Promise((resolve) => {
    if (!socket) {
      resolve();
      return;
    }
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function listenHttp(server: NodeHttp.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Nearby pairing listener did not receive a TCP port."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "0.0.0.0");
  });
}

function bindDiscoverySocket(socket: NodeDgram.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      socket.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(LAN_DISCOVERY_PORT);
  });
}

function discoveryIssueOf(cause: unknown): DesktopLanDiscoveryIssue {
  const code =
    cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : null;
  if (code === "EACCES" || code === "EPERM") {
    return {
      kind: "permission-denied",
      title: "Local network permission is blocked",
      detail:
        "Allow Solla Code through the operating system firewall for the current network profile. Discovery retries automatically after permission is granted.",
    };
  }
  if (code === "EADDRINUSE") {
    return {
      kind: "port-unavailable",
      title: "Nearby discovery port is already in use",
      detail:
        "Another Solla Code process or application is using UDP port 37731. Close the older instance; this one will retry automatically.",
    };
  }
  if (
    code === "EADDRNOTAVAIL" ||
    code === "ENETDOWN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH"
  ) {
    return {
      kind: "network-unavailable",
      title: "No private network is available",
      detail:
        "Connect this device to Wi-Fi or Ethernet and keep Solla Code open. Nearby discovery retries automatically when the network returns.",
    };
  }
  return {
    kind: "unknown",
    title: "Nearby discovery needs attention",
    detail:
      cause instanceof Error
        ? `${cause.message} Solla Code will keep retrying automatically.`
        : "Solla Code will keep retrying nearby discovery automatically.",
  };
}

export function pairingRequestErrorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.name === "AbortError") {
    return "The nearby trust request timed out. Keep Solla Code open on both devices, confirm the trust prompt, and try again.";
  }
  const message = cause instanceof Error ? cause.message : "";
  if (/declined|denied|cancelled/u.test(message.toLowerCase())) {
    return message;
  }
  const nestedCause =
    cause instanceof Error && "cause" in cause && cause.cause instanceof Error
      ? cause.cause
      : cause;
  const code =
    nestedCause instanceof Error && "code" in nestedCause && typeof nestedCause.code === "string"
      ? nestedCause.code
      : null;
  if (
    cause instanceof TypeError ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT"
  ) {
    return "The other device was discovered but could not be reached. Keep Solla Code open and allow it through the firewall for the current network profile, then try again.";
  }
  return message || "The nearby trust request failed.";
}

export const make = Effect.gen(function* () {
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const instanceId = NodeCrypto.randomUUID();
  const deviceLabel = NodeOS.hostname().trim() || "Solla Code Desktop";
  const peers = new Map<string, InternalLanPeer>();
  const pendingIncoming = new Map<string, PendingIncomingPairing>();
  let pairingPort = 0;
  let activeUdpSocket: NodeDgram.Socket | null = null;
  let advertisementInterval: NodeJS.Timeout | null = null;
  let retryInterval: NodeJS.Timeout | null = null;
  let discoveryStartPromise: Promise<void> | null = null;
  let discoveryIssue: DesktopLanDiscoveryIssue | null = null;
  let advertisedEnvironmentId: EnvironmentId | null = null;
  let advertisedEnvironmentEndpoint: string | null = null;
  let environmentDescriptorRequest: Promise<void> | null = null;
  let shuttingDown = false;

  const removePending = (requestId: string) => {
    const pending = pendingIncoming.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingIncoming.delete(requestId);
  };

  const handlePairingRequest = Effect.fn("desktop.lanDiscovery.handlePairingRequest")(function* (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (!isPrivateLanAddress(remoteAddress)) {
      respondJson(response, 403, { error: "Nearby pairing is limited to private networks." });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/pair") {
      respondJson(response, 404, { error: "Not found." });
      return;
    }

    const rawBody = yield* Effect.tryPromise({
      try: () => readJsonBody(request),
      catch: (cause) =>
        new DesktopLanPairingError({
          operation: "read-request",
          detail: cause instanceof Error ? cause.message : "Invalid nearby pairing request.",
          cause,
        }),
    });
    const decoded = decodeIncomingLanPairingRequest(rawBody);
    if (Option.isNone(decoded) || decoded.value.instanceId === instanceId) {
      respondJson(response, 400, { error: "Invalid nearby pairing request." });
      return;
    }

    const pairingRequest = decoded.value;
    const decision = yield* dialog.showMessageBox({
      type: "question",
      title: "Trust nearby Solla Code?",
      message: `${pairingRequest.label} wants to connect to this Solla Code instance.`,
      detail:
        "Trusting it adds each environment to the other device. Only approve devices you recognize on this private network.",
      buttons: ["Decline", "Trust and connect"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (decision.response !== 1) {
      respondJson(response, 403, { error: "The other device declined the trust request." });
      return;
    }

    const timeout = setTimeout(() => {
      const pending = pendingIncoming.get(pairingRequest.requestId);
      if (!pending) return;
      respondJson(pending.response, 408, {
        error: "The trusted device did not finish pairing in time.",
      });
      removePending(pairingRequest.requestId);
    }, LAN_PAIRING_TIMEOUT_MS);
    pendingIncoming.set(pairingRequest.requestId, { response, timeout });
    response.once("close", () => {
      if (!response.writableEnded) removePending(pairingRequest.requestId);
    });

    const event: DesktopLanPairingApprovedEvent = {
      type: "approved-request",
      requestId: pairingRequest.requestId,
      initiatorLabel: pairingRequest.label,
      initiatorPairingUrl: pairingRequest.initiatorPairingUrl,
    };
    yield* windows.sendAll(IpcChannels.LAN_PAIRING_EVENT_CHANNEL, event);
  });

  const httpServer = NodeHttp.createServer((request, response) => {
    void Effect.runPromise(
      handlePairingRequest(request, response).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            respondJson(response, 500, {
              error: cause instanceof Error ? cause.message : "Nearby pairing failed.",
            });
          }),
        ),
      ),
    );
  });

  const handleAdvertisement = (message: Buffer, remote: NodeDgram.RemoteInfo) => {
    if (!isPrivateLanAddress(remote.address)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toString("utf8")) as unknown;
    } catch {
      return;
    }
    const decoded = decodeLanAdvertisement(parsed);
    if (Option.isNone(decoded) || decoded.value.instanceId === instanceId) return;
    const backendUrl = peerBackendUrl(decoded.value, remote);
    if (!backendUrl) return;
    peers.set(decoded.value.instanceId, {
      id: decoded.value.instanceId,
      environmentId: decoded.value.environmentId ?? null,
      label: decoded.value.label,
      backendUrl,
      lastSeenAt: Date.now(),
      pairingOrigin: `http://${remote.address}:${decoded.value.pairingPort}`,
    });
  };

  const advertise = (socket: NodeDgram.Socket) => {
    void Effect.runPromise(serverExposure.getState)
      .then((state) => {
        if (!state.endpointUrl || socket !== activeUdpSocket) return;
        if (advertisedEnvironmentEndpoint !== state.endpointUrl) {
          advertisedEnvironmentEndpoint = state.endpointUrl;
          advertisedEnvironmentId = null;
          environmentDescriptorRequest = null;
        }
        if (advertisedEnvironmentId === null && environmentDescriptorRequest === null) {
          environmentDescriptorRequest = fetch(`${state.endpointUrl}/.well-known/t3/environment`, {
            signal: AbortSignal.timeout(LAN_ENVIRONMENT_DESCRIPTOR_TIMEOUT_MS),
          })
            .then(async (response) => {
              if (!response.ok) return;
              const descriptor = decodeEnvironmentDescriptor(await response.json());
              if (Option.isSome(descriptor)) {
                advertisedEnvironmentId = descriptor.value.environmentId;
              }
            })
            .catch(() => undefined)
            .finally(() => {
              environmentDescriptorRequest = null;
            });
        }
        const broadcastAddresses = lanBroadcastAddresses(NodeOS.networkInterfaces());
        if (broadcastAddresses.length === 0) {
          discoveryIssue = {
            kind: "network-unavailable",
            title: "No private network is available",
            detail:
              "Connect this device to private Wi-Fi or Ethernet. Solla Code will begin advertising automatically when the network returns.",
          };
          return;
        }
        discoveryIssue = null;
        const advertisement: LanAdvertisement = {
          type: "solla-code-lan",
          version: 1,
          instanceId,
          ...(advertisedEnvironmentId === null ? {} : { environmentId: advertisedEnvironmentId }),
          label: deviceLabel,
          backendUrl: state.endpointUrl,
          pairingPort,
        };
        const payload = Buffer.from(JSON.stringify(advertisement));
        for (const broadcastAddress of broadcastAddresses) {
          socket.send(payload, LAN_DISCOVERY_PORT, broadcastAddress, () => undefined);
        }
      })
      .catch((cause) => {
        discoveryIssue = discoveryIssueOf(cause);
      });
  };

  const stopActiveUdpSocket = (socket: NodeDgram.Socket, cause?: unknown) => {
    if (socket !== activeUdpSocket) return;
    activeUdpSocket = null;
    if (advertisementInterval) {
      clearInterval(advertisementInterval);
      advertisementInterval = null;
    }
    if (cause !== undefined) {
      discoveryIssue = discoveryIssueOf(cause);
    }
    void closeSocket(socket);
  };

  const ensureDiscoveryStarted = async (): Promise<void> => {
    if (shuttingDown || activeUdpSocket) return;
    if (discoveryStartPromise) return discoveryStartPromise;

    const start = async () => {
      const socket = NodeDgram.createSocket({ type: "udp4", reuseAddr: true });
      try {
        await bindDiscoverySocket(socket);
        socket.setBroadcast(true);
      } catch (cause) {
        discoveryIssue = discoveryIssueOf(cause);
        await closeSocket(socket);
        return;
      }
      if (shuttingDown) {
        await closeSocket(socket);
        return;
      }
      activeUdpSocket = socket;
      discoveryIssue = null;
      socket.on("message", handleAdvertisement);
      socket.on("error", (cause) => stopActiveUdpSocket(socket, cause));
      advertise(socket);
      advertisementInterval = setInterval(() => advertise(socket), LAN_ADVERTISEMENT_INTERVAL_MS);
    };

    discoveryStartPromise = start();
    try {
      await discoveryStartPromise;
    } finally {
      discoveryStartPromise = null;
    }
  };

  const resources = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<NetworkResources> => {
        pairingPort = await listenHttp(httpServer);
        await ensureDiscoveryStarted();
        retryInterval = setInterval(() => {
          void ensureDiscoveryStarted();
        }, LAN_DISCOVERY_RETRY_INTERVAL_MS);
        return { httpServer };
      },
      catch: (cause) =>
        new DesktopLanPairingError({
          operation: "start-discovery",
          detail: "Could not start nearby Solla Code discovery.",
          cause,
        }),
    }),
    (active) =>
      Effect.promise(async () => {
        shuttingDown = true;
        if (retryInterval) clearInterval(retryInterval);
        if (advertisementInterval) clearInterval(advertisementInterval);
        for (const [requestId, pending] of pendingIncoming) {
          respondJson(pending.response, 503, { error: "Solla Code is shutting down." });
          removePending(requestId);
        }
        await Promise.all([closeSocket(activeUdpSocket), closeServer(active.httpServer)]);
      }),
  );
  void resources;

  const listPeers = Effect.sync(() => {
    const cutoff = Date.now() - LAN_PEER_STALE_AFTER_MS;
    const active: DesktopLanPeer[] = [];
    for (const [peerId, peer] of peers) {
      if (peer.lastSeenAt < cutoff) {
        peers.delete(peerId);
        continue;
      }
      active.push({
        id: peer.id,
        environmentId: peer.environmentId,
        label: peer.label,
        backendUrl: peer.backendUrl,
        lastSeenAt: peer.lastSeenAt,
      });
    }
    return active.toSorted((left, right) => left.label.localeCompare(right.label));
  });

  const getState = listPeers.pipe(
    Effect.map(
      (activePeers) =>
        ({
          status: activeUdpSocket && discoveryIssue === null ? "ready" : "retrying",
          peers: activePeers,
          issue: discoveryIssue,
        }) satisfies DesktopLanDiscoveryState,
    ),
  );

  const requestPairing = Effect.fn("desktop.lanDiscovery.requestPairing")(function* (
    input: DesktopLanPairingRequestInput,
  ) {
    const peer = peers.get(input.peerId);
    if (!peer || peer.lastSeenAt < Date.now() - LAN_PEER_STALE_AFTER_MS) {
      return yield* new DesktopLanPairingError({
        operation: "request-pairing",
        detail:
          "That nearby Solla Code instance is no longer available. Keep it open on the same private network and wait for it to reappear.",
      });
    }
    const requestId = NodeCrypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LAN_PAIRING_TIMEOUT_MS);
    const result = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${peer.pairingOrigin}/v1/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId,
            instanceId,
            label: deviceLabel,
            initiatorPairingUrl: input.initiatorPairingUrl,
          } satisfies IncomingLanPairingRequest),
          signal: controller.signal,
        });
        const body = (await response.json()) as {
          readonly responderPairingUrl?: unknown;
          readonly error?: unknown;
        };
        if (!response.ok || typeof body.responderPairingUrl !== "string") {
          throw new Error(
            typeof body.error === "string" ? body.error : "The nearby trust request failed.",
          );
        }
        return {
          requestId,
          responderPairingUrl: body.responderPairingUrl,
        } satisfies DesktopLanPairingRequestResult;
      },
      catch: (cause) =>
        new DesktopLanPairingError({
          operation: "request-pairing",
          detail: pairingRequestErrorDetail(cause),
          cause,
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));
    return result;
  });

  const completePairing = Effect.fn("desktop.lanDiscovery.completePairing")(function* (
    input: DesktopLanPairingCompletionInput,
  ) {
    const pending = pendingIncoming.get(input.requestId);
    if (!pending) {
      return yield* new DesktopLanPairingError({
        operation: "complete-pairing",
        detail: "The nearby pairing request is no longer active.",
      });
    }
    if (input.error) {
      respondJson(pending.response, 500, { error: input.error });
    } else if (input.responderPairingUrl) {
      respondJson(pending.response, 200, {
        responderPairingUrl: input.responderPairingUrl,
      });
    } else {
      respondJson(pending.response, 400, {
        error: "The trusted device did not provide a pairing credential.",
      });
    }
    removePending(input.requestId);
  });

  return DesktopLanDiscovery.of({
    listPeers,
    getState,
    requestPairing,
    completePairing,
  });
});

export const layer = Layer.effect(DesktopLanDiscovery, make);
