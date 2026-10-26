// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Disposable dev-only setup; no server or browser launch.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ExecutionEnvironmentDescriptor,
  ThreadId,
  WsPreviewOpenRpc,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const rpcGroup = RpcGroup.make(WsPreviewOpenRpc);

function isolatedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Supply a valid isolated loopback development URL.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port === "3773" ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Only isolated loopback HTTP development origins, excluding port 3773, are allowed.",
    );
  }
  return url;
}

const openTab = (base: string, bearerToken: string, threadId: string) => {
  const socket = new URL("/ws", base);
  socket.protocol = "ws:";
  const constructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      }) as unknown as globalThis.WebSocket,
  );
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(socket.toString()).pipe(Layer.provide(constructor)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  return Effect.runPromise(
    RpcClient.make(rpcGroup).pipe(
      Effect.flatMap((client) => client["preview.open"]({ threadId: ThreadId.make(threadId) })),
      Effect.provide(protocol),
      Effect.scoped,
      Effect.timeout("15 seconds"),
    ),
  );
};

/** Consumes only the caller-supplied agent pairing URL; the viewer pairs separately. */
export async function bootstrapPreviewIntegration(
  input: { baseUrl: string; pairingUrl: string; threadId: string },
  dependencies: {
    fetch?: typeof fetch;
    openTab?: (base: string, bearer: string, threadId: string) => Promise<PreviewSessionSnapshot>;
  } = {},
) {
  const base = isolatedOrigin(input.baseUrl).origin;
  const pairing = isolatedOrigin(input.pairingUrl);
  const credential = new URLSearchParams(pairing.hash.slice(1)).get("token");
  if (pairing.pathname !== "/pair" || !credential?.trim() || !input.threadId.trim()) {
    throw new Error("Supply an agent-owned /pair#token= URL and an existing fixture thread ID.");
  }
  const request = dependencies.fetch ?? fetch;
  const readJson = async (path: string, options?: RequestInit): Promise<unknown> => {
    const response = await request(new URL(path, base), {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Development endpoint rejected the request.");
    return response.json();
  };
  // Descriptor discovery must succeed before consuming the single-use pairing token.
  const descriptor = await readJson("/.well-known/t3/environment")
    .then(Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor))
    .catch(() => {
      throw new Error("Development environment discovery failed; pairing was not attempted.");
    });
  const access = await readJson("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      client_label: "Solla preview integration fixture",
    }).toString(),
  })
    .then(Schema.decodeUnknownSync(AuthAccessTokenResult))
    .catch(() => {
      throw new Error(
        "Agent pairing failed; check the dev environment and use a fresh agent-owned token.",
      );
    });
  if (access.token_type !== "Bearer")
    throw new Error("The development endpoint did not issue a bearer session.");
  const privateDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "solla-preview-session-"),
  );
  const bearerFile = NodePath.join(privateDirectory, "bearer.txt");
  NodeFS.writeFileSync(bearerFile, access.access_token, { flag: "wx", mode: 0o600 });
  const tab = await (dependencies.openTab ?? openTab)(
    base,
    access.access_token,
    input.threadId,
  ).catch(() => {
    throw new Error(`Preview tab creation failed; its dev bearer is retained at ${bearerFile}.`);
  });
  return {
    environmentId: descriptor.environmentId,
    threadId: tab.threadId,
    tabId: tab.tabId,
    bearerFile,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const argument = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const baseUrl = argument("base-url");
  const threadId = argument("thread-id");
  const pairingFile = argument("pairing-url-file");
  const pairingUrl = pairingFile
    ? NodeFS.readFileSync(pairingFile, "utf8").trim()
    : process.env.BENCH_AGENT_PAIRING_URL;
  if (!baseUrl || !threadId || !pairingUrl) {
    throw new Error(
      "Supply --base-url, --thread-id, and --pairing-url-file (or BENCH_AGENT_PAIRING_URL).",
    );
  }
  console.log(JSON.stringify(await bootstrapPreviewIntegration({ baseUrl, threadId, pairingUrl })));
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Integration bootstrap failed.");
    process.exitCode = 1;
  });
}
