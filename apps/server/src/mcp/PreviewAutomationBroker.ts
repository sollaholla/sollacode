import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PREVIEW_AUTOMATION_REASON_MAX_LENGTH,
  PreviewAutomationExecutionError,
  PreviewAutomationForeignAgentTabError,
  PreviewAutomationHumanVerificationRequiredError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewCredentialVaultError,
  PreviewHumanVerification,
  PreviewTabId,
  type PreviewCredentialVaultCommand,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { PreviewManager } from "../preview/Manager.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveOwningThreadIdWith } from "./owningThread.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface PreviewCredentialVaultInvokeInput {
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly command: PreviewCredentialVaultCommand;
  readonly timeoutMs?: number;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
    /**
     * Relays a settings screen's change to the saved passwords kept by the
     * desktop app on the environment's own machine. The result is whatever
     * that desktop answered; callers decode it.
     */
    readonly manageCredentials: (
      request: PreviewCredentialVaultInvokeInput,
    ) => Effect.Effect<unknown, PreviewCredentialVaultError>;
  }
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly environmentLocal: boolean;
  readonly manageCredentials: boolean;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  readonly context: PreviewAutomationRequestErrorContext;
}

/** A credential vault request waiting on its desktop. It carries no command, so no secret. */
interface PendingCredentialVaultRequest {
  readonly queue: ClientConnection["queue"];
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly deferred: Deferred.Deferred<unknown, PreviewCredentialVaultError>;
}

/**
 * A lease pinning one provider session to one desktop runtime. It lives exactly
 * as long as the connection it names: `connectionId`/`queue` identity is what
 * makes a lease valid, so a disconnected or replaced host is dropped on the next
 * lookup. The lease deliberately has no clock of its own — it used to inherit
 * the MCP credential's expiry, which coupled host stickiness to an unrelated
 * auth deadline and could migrate a live session to another runtime mid-flow.
 */
interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly queue: ClientConnection["queue"];
  readonly tabId?: PreviewTabId;
  readonly tabSequence?: number;
  /**
   * Last tab each caller in this group drove, keyed by its own thread id
   * before the side-chat remap.
   *
   * The group shares one browser on purpose, but it also shared this ONE
   * `tabId` — the implicit target for every call that omits one. A parent and
   * its side chat therefore silently repointed each other's "current tab"
   * after every request, which is what "they fight each other a lot on using
   * the same tabs" looks like from the inside. Each caller now remembers its
   * own, and the group-wide `tabId` above is no longer a targeting fallback.
   *
   * Keyed by thread id rather than `providerSessionId` on purpose: a provider
   * session is a fresh UUID from every `prepareMcpSession`, so a model switch,
   * a usage-limit failover or a resume would rotate it and lose the pointer
   * mid-work. It also matches the invariant this file's own tests assert —
   * host ownership belongs to the thread, not to whichever provider session
   * issued the first request.
   *
   * KNOWN GAP: a CLI spawned in one of the thread's terminal panes gets its
   * own preview-capable MCP credential carrying the SAME thread id (see
   * `issueTerminalAgentMcpCredential`), so it shares a key with the thread's
   * chat agent and the two still share one pointer. `heldBy` on the status
   * result still tells each of them the tab is taken; only the implicit
   * target is unseparated. Splitting that needs a caller identity that is
   * both stable and distinct, which does not exist today.
   */
  readonly tabByCaller?: ReadonlyMap<string, PreviewTabId>;
}

interface PreviewAutomationRequestErrorContext {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly providerSessionId: string;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly clientId: string;
  readonly connectionId: ClientConnection["connectionId"];
  readonly requestId: string;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs: number;
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly assignments: ReadonlyMap<string, HostAssignment>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly vaultPending: ReadonlyMap<string, PendingCredentialVaultRequest>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

const PREVIEW_AUTOMATION_HOST_QUEUE_CAPACITY = 64;
const CREDENTIAL_VAULT_TIMEOUT_MS = 15_000;
const CREDENTIAL_VAULT_MESSAGE_MAX_LENGTH = 300;

interface RemovedConnection {
  readonly state: BrokerState;
  readonly disconnected: ReadonlyArray<PendingRequest>;
  readonly disconnectedVault: ReadonlyArray<PendingCredentialVaultRequest>;
}

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): RemovedConnection => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const pending = new Map(current.pending);
  const vaultPending = new Map(current.vaultPending);
  const disconnected: PendingRequest[] = [];
  const disconnectedVault: PendingCredentialVaultRequest[] = [];
  if (current.clients.get(clientId)?.queue === queue) clients.delete(clientId);
  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  for (const [requestId, entry] of vaultPending) {
    if (entry.queue !== queue) continue;
    vaultPending.delete(requestId);
    disconnectedVault.push(entry);
  }
  return {
    state: { ...current, clients, assignments, pending, vaultPending },
    disconnected,
    disconnectedVault,
  };
};

const credentialVaultError = (
  reason: PreviewCredentialVaultError["reason"],
  message: string,
): PreviewCredentialVaultError => new PreviewCredentialVaultError({ reason, message });

const desktopDisconnectedError = () =>
  credentialVaultError(
    "desktopDisconnected",
    "The desktop app disconnected before it answered. Try again.",
  );

/**
 * The desktop's own words for why a vault change failed, such as a site that
 * is not HTTPS. They reach a person, not a model, but are still bounded and
 * kept to one line.
 */
const credentialVaultRejection = (message: string): PreviewCredentialVaultError => {
  const text = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return credentialVaultError(
    "rejected",
    text.length === 0
      ? "The desktop app could not change the saved passwords."
      : text.length > CREDENTIAL_VAULT_MESSAGE_MAX_LENGTH
        ? `${text.slice(0, CREDENTIAL_VAULT_MESSAGE_MAX_LENGTH - 1)}…`
        : text,
  );
};

const selectorDiagnosticsFromInput = (
  input: unknown,
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (typeof input !== "object" || input === null) return {};
  if ("locator" in input && typeof input.locator === "string") {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }
  if ("selector" in input && typeof input.selector === "string") {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }
  return {};
};

const hostAssignmentKey = (scope: McpInvocationContext.McpInvocationScope): string =>
  `${scope.environmentId}\u0000${scope.threadId}`;

const isPreviewTabId = Schema.is(PreviewTabId);
const isPreviewHumanVerification = Schema.is(PreviewHumanVerification);

/**
 * Operations that take the keyboard or pointer, and so wait for the user.
 *
 * The desktop holds these while a person is typing or clicking (its
 * `deferToUserInput`), and that wait used to be charged against the request's
 * own deadline: a user composing a message for longer than the 15s default
 * made every one of them "time out", and the model was told so in the same
 * words as a page that failed to respond. Live 2026-09-03 (Pawstalgia, Suno):
 * two clicks expired inside the wait, nothing was dispatched, and the model
 * concluded the site's menus rejected automation. The grace below is time
 * for the person, on top of the time for the page.
 */
const USER_INPUT_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "click",
  "drag",
  "type",
  "press",
]);
/**
 * Enough that the deferral wait can use the whole request budget below: the
 * person's typing pause should never be what ends the call. `min(timeoutMs +
 * grace, ...)` with a 30s grace capped an ordinary 15s click at 45s and spent
 * the last 5s of the budget on nothing.
 */
export const USER_INPUT_DEFERRAL_GRACE_MS = 60_000;
/**
 * The MCP client waits 60s for a tool call (the SDK default, and the LAN Chat
 * client's), then reports "Request timed out" and discards whatever the
 * desktop later returns. Every request therefore has to settle inside that,
 * with room for the hop back.
 */
export const PREVIEW_REQUEST_BUDGET_MS = 50_000;
/**
 * The desktop enforces the same deadline it was sent, and its failure names
 * the exact step that gave out; the broker's own timeout only says "timed
 * out". Let the desktop's answer win the race.
 */
const BROKER_DEADLINE_MARGIN_MS = 1_500;

/** How long the broker waits for one request, given the caller's timeout. */
export function previewRequestDeadlineMs(
  operation: PreviewAutomationOperation,
  timeoutMs: number,
): number {
  const grace = USER_INPUT_OPERATIONS.has(operation) ? USER_INPUT_DEFERRAL_GRACE_MS : 0;
  return Math.min(timeoutMs + grace, Math.max(timeoutMs, PREVIEW_REQUEST_BUDGET_MS));
}

/**
 * Stamp each tab in a status result with who in this thread group last drove
 * it, from the broker's own per-caller record.
 *
 * The renderer builds those summaries and has no idea which session asked, so
 * this is the only place the two facts meet. Tabs nobody has driven through
 * automation are left unstamped rather than labelled "free" — the desktop's
 * own `agentActive` flag is a single process-wide boolean that can only ever
 * mark one tab, so an absent stamp genuinely means "not known", not "idle".
 *
 * This is also what covers the case the per-caller pointer cannot: when a
 * caller has no tab of its own, the renderer still resolves the implicit
 * target from shared panel state (the thread's visible guest), so it can
 * still land in a tab a peer is working in. It now arrives knowing that.
 */
function stampTabHolders(
  result: unknown,
  tabByCaller: ReadonlyMap<string, PreviewTabId> | undefined,
  callerKey: string,
): unknown {
  if (tabByCaller === undefined || tabByCaller.size === 0) return result;
  if (typeof result !== "object" || result === null || !("tabs" in result)) return result;
  const tabs = (result as { tabs: unknown }).tabs;
  if (!Array.isArray(tabs)) return result;
  const ownerByTabId = new Map<string, string>();
  for (const [caller, tabId] of tabByCaller) {
    // First writer wins only for a foreign caller; the reader's own claim
    // always takes precedence, so a tab both have touched reads as "you".
    if (caller === callerKey || !ownerByTabId.has(String(tabId))) {
      ownerByTabId.set(String(tabId), caller);
    }
  }
  return {
    ...result,
    tabs: tabs.map((tab) => {
      if (typeof tab !== "object" || tab === null || !("tabId" in tab)) return tab;
      const owner = ownerByTabId.get(String((tab as { tabId: unknown }).tabId));
      if (owner === undefined) return tab;
      return { ...tab, heldBy: owner === callerKey ? "you" : "peer" };
    }),
  };
}

const readResultTabId = (result: unknown): PreviewTabId | null | undefined => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return undefined;
  const tabId = result.tabId;
  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function remoteDetailKind(detail: unknown): RemoteDetailKind {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/**
 * The client composes `detail.reason` from its error's structured fields (never
 * page text); it is the one remote string allowed into a model-facing message,
 * bounded and stripped of control characters here again.
 */
const remoteReason = (detail: unknown): string | undefined => {
  if (typeof detail !== "object" || detail === null || !("reason" in detail)) return undefined;
  const raw = (detail as { reason?: unknown }).reason;
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > PREVIEW_AUTOMATION_REASON_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_AUTOMATION_REASON_MAX_LENGTH - 1)}…`
    : text;
};

const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const reason = remoteReason(error.detail);
  const executionReason = reason === undefined ? {} : { reason };
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };
  switch (error._tag) {
    case "PreviewAutomationNoAvailableHostError":
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationForeignAgentTabError":
      return new PreviewAutomationForeignAgentTabError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationHumanVerificationRequiredError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const verification =
        detail && "verification" in detail && isPreviewHumanVerification(detail.verification)
          ? detail.verification
          : undefined;
      return verification
        ? new PreviewAutomationHumanVerificationRequiredError({
            ...context,
            ...remoteDiagnostics,
            verification,
          })
        : new PreviewAutomationExecutionError({
            ...context,
            ...remoteDiagnostics,
            ...executionReason,
          });
    }
    case "PreviewAutomationInvalidSelectorError": {
      return new PreviewAutomationInvalidSelectorError({
        ...context,
        ...remoteDiagnostics,
      });
    }
    case "PreviewAutomationTargetNotEditableError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteSelectorKind =
        detail &&
        "selectorKind" in detail &&
        (detail.selectorKind === "focused-element" ||
          detail.selectorKind === "locator" ||
          detail.selectorKind === "selector")
          ? detail.selectorKind
          : undefined;
      const remoteSelectorLength =
        detail &&
        "selectorLength" in detail &&
        typeof detail.selectorLength === "number" &&
        Number.isInteger(detail.selectorLength) &&
        detail.selectorLength >= 0
          ? detail.selectorLength
          : undefined;
      const remoteNativeMenu =
        detail && "nativeMenu" in detail && typeof detail.nativeMenu === "boolean"
          ? detail.nativeMenu
          : undefined;
      return new PreviewAutomationTargetNotEditableError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteNativeMenu === undefined ? {} : { nativeMenu: remoteNativeMenu }),
        ...(remoteSelectorKind === undefined && context.selectorKind === undefined
          ? {}
          : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
        ...(remoteSelectorLength === undefined && context.selectorLength === undefined
          ? {}
          : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const maximumBytes =
        detail &&
        "maximumBytes" in detail &&
        typeof detail.maximumBytes === "number" &&
        Number.isInteger(detail.maximumBytes) &&
        detail.maximumBytes > 0
          ? detail.maximumBytes
          : undefined;
      return new PreviewAutomationResultTooLargeError({
        ...context,
        ...remoteDiagnostics,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    default:
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
        ...executionReason,
      });
  }
};

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const previewManager = yield* PreviewManager;
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    pending: new Map(),
    vaultPending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    removed: Pick<RemovedConnection, "disconnected" | "disconnectedVault">,
  ) {
    yield* Effect.forEach(
      removed.disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Effect.forEach(
      removed.disconnectedVault,
      ({ deferred }) => Deferred.fail(deferred, desktopDisconnectedError()),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const removed = yield* SynchronizedRef.modify(state, (current) => {
      const next = removeConnectionFromState(current, clientId, queue);
      return [next, next.state] as const;
    });
    yield* closeConnection(queue, removed);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.bounded<PreviewAutomationStreamEvent>(
      PREVIEW_AUTOMATION_HOST_QUEUE_CAPACITY,
    );
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      environmentLocal: host.environmentLocal ?? false,
      manageCredentials: host.manageCredentials ?? false,
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);
      const removed: RemovedConnection = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [], disconnectedVault: [] };
      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);
      return [
        {
          previousConnection,
          removed,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.removed);
    }
    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    yield* SynchronizedRef.update(state, (current) => {
      const currentHost = current.clients.get(host.clientId);
      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return current;
      }
      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
      });
      return { ...current, clients, focusSequence };
    });
  });

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const vaultPending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.vaultPending.get(response.requestId);
      if (
        !entry ||
        entry.clientId !== response.clientId ||
        entry.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
      const next = new Map(current.vaultPending);
      next.delete(response.requestId);
      return [entry, { ...current, vaultPending: next }] as const;
    });
    if (vaultPending) {
      yield* response.ok
        ? Deferred.succeed(vaultPending.deferred, response.result)
        : Deferred.fail(
            vaultPending.deferred,
            credentialVaultRejection(response.error?.message ?? ""),
          );
      return;
    }
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
      const next = new Map(current.pending);
      next.delete(response.requestId);
      return [entry, { ...current, pending: next }] as const;
    });
    if (!pending) return;
    if (response.ok) {
      yield* Deferred.succeed(pending.deferred, response.result);
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    rawInput: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    // A side chat browses in its PARENT's tab strip, not a private one. The
    // parent is the surface the user actually watches, so a tab an assistant
    // opens from a side chat is visible to them instead of hidden behind a
    // chat they may never open. Side chats already inherit the parent's
    // browserProfileThreadId, so this is the same browser session either way.
    // Routing here rather than in the toolkit covers every preview operation
    // and every caller, and keeps the host-assignment key consistent with the
    // thread the tabs actually belong to.
    const owningThreadId = yield* resolveOwningThreadIdWith(projections, rawInput.scope.threadId);
    // The remap below is what makes a side chat share its parent's browser. It
    // also erases who is calling, so keep the pre-remap id: it is the only
    // thing that tells one member of the group from another.
    const callerKey = String(rawInput.scope.threadId);
    const input =
      owningThreadId === rawInput.scope.threadId
        ? rawInput
        : { ...rawInput, scope: { ...rawInput.scope, threadId: owningThreadId } };
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deadlineMs = previewRequestDeadlineMs(input.operation, timeoutMs);
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const route = yield* SynchronizedRef.modify(state, (current) => {
      const assignments = new Map(
        Array.from(current.assignments).filter(([, assignment]) => {
          const connection = current.clients.get(assignment.clientId);
          return (
            connection?.connectionId === assignment.connectionId &&
            connection.queue === assignment.queue
          );
        }),
      );
      const assignmentKey = hostAssignmentKey(input.scope);
      const assigned = assignments.get(assignmentKey);
      const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
      const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
      // Keep one provider session on one physical desktop runtime so a
      // multi-step browser interaction cannot jump between independent
      // Electron cookie/DOM state. A live assignment that predates an
      // operation is not silently moved to a newer client: the caller gets a
      // capability failure and can deliberately start a fresh provider
      // session. A dead lease is pruned above and may fail over.
      const connection =
        hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
          ? assignedConnection
          : hasLiveAssignment
            ? undefined
            : Array.from(current.clients.values())
                .filter(
                  (host) =>
                    host.environmentId === input.scope.environmentId &&
                    supportsOperation(host, input.operation),
                )
                .sort(
                  (left, right) =>
                    right.supportedOperations.size - left.supportedOperations.size ||
                    // Above focus deliberately. Whichever host runs the request
                    // renders the guest, so this is the difference between an
                    // agent browsing as the machine that owns the environment —
                    // and its logins — and browsing as whichever screen the user
                    // last looked at. Focus only breaks ties among equals.
                    Number(right.environmentLocal) - Number(left.environmentLocal) ||
                    Number(right.focused) - Number(left.focused) ||
                    right.focusOrder - left.focusOrder,
                )[0];
      if (!connection) {
        if (!hasLiveAssignment) assignments.delete(assignmentKey);
        return [undefined, { ...current, assignments }] as const;
      }
      const canReuseAssignedTab =
        assigned !== undefined &&
        assigned.connectionId === connection.connectionId &&
        assigned.queue === connection.queue;
      assignments.set(assignmentKey, {
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        queue: connection.queue,
        ...(canReuseAssignedTab && assigned.tabId !== undefined ? { tabId: assigned.tabId } : {}),
        ...(canReuseAssignedTab && assigned.tabByCaller !== undefined
          ? { tabByCaller: assigned.tabByCaller }
          : {}),
        ...(canReuseAssignedTab && assigned.tabSequence !== undefined
          ? { tabSequence: assigned.tabSequence }
          : {}),
      });

      const requestSequence = current.requestSequence;
      const requestId = `preview-${requestSequence}`;
      // The implicit target is the tab THIS caller last drove, and nothing
      // else. It used to fall through to one tab shared by the whole group,
      // which is what handed a side chat its parent's tab and then handed it
      // back on the next call. A caller with no tab of its own sends none and
      // gets a fresh one, rather than silently adopting a peer's.
      const tabId =
        input.tabId ?? (canReuseAssignedTab ? assigned.tabByCaller?.get(callerKey) : undefined);
      const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);
      const context: PreviewAutomationRequestErrorContext = {
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        requestId,
        ...(tabId === undefined ? {} : { tabId }),
        timeoutMs,
        ...selectorDiagnostics,
      };
      const pending = new Map(current.pending);
      pending.set(requestId, { queue: connection.queue, deferred, context });
      return [
        { connection, requestId, requestContext: context, requestSequence },
        { ...current, assignments, pending, requestSequence: current.requestSequence + 1 },
      ] as const;
    });
    if (!route) {
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
      });
    }
    const { connection, requestId, requestContext, requestSequence } = route;
    // Mobile frame capture polls snapshot/status without a person interacting.
    // Those probes must not keep an abandoned tab alive.
    const countsAsActivity =
      input.operation !== "status" &&
      input.operation !== "close" &&
      !(input.scope.providerInstanceId === "mobileBrowser" && input.operation === "snapshot");
    const noteActivity = (tabId: string | null | undefined) =>
      tabId && countsAsActivity
        ? previewManager
            .reportActivity({ threadId: input.scope.threadId, tabId, interacted: true })
            .pipe(Effect.catch(() => Effect.void))
        : Effect.void;
    yield* noteActivity(requestContext.tabId);
    const expiresAt = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + deadlineMs;
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const result = yield* Effect.gen(function* () {
        const offered = yield* Queue.offer(connection.queue, {
          type: "request",
          connectionId: connection.connectionId,
          request: {
            requestId,
            threadId: input.scope.threadId,
            tabId: requestContext.tabId,
            tabIdExplicit: input.tabId !== undefined,
            operation: input.operation,
            input: input.input,
            timeoutMs,
            expiresAt,
          },
        });
        if (!offered) {
          const completion = yield* Deferred.poll(deferred);
          if (Option.isSome(completion)) {
            return (yield* completion.value) as A;
          }
          return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
        }
        return (yield* Deferred.await(deferred)) as A;
      }).pipe(Effect.timeoutOption(deadlineMs + BROKER_DEADLINE_MARGIN_MS));
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: Effect.succeed,
      });
    });
    const withTabHolders = (value: A, key: string, caller: string) =>
      SynchronizedRef.get(state).pipe(
        Effect.map(
          (current) =>
            stampTabHolders(value, current.assignments.get(key)?.tabByCaller, caller) as A,
        ),
      );
    const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
    const responseTabId = readResultTabId(result);
    const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;
    yield* noteActivity(responseTabId === undefined ? requestContext.tabId : responseTabId);
    const assignmentKey = hostAssignmentKey(input.scope);
    if (resultTabId === undefined) {
      return yield* withTabHolders(result, assignmentKey, callerKey);
    }
    yield* SynchronizedRef.update(state, (current) => {
      const assignment = current.assignments.get(assignmentKey);
      if (
        !assignment ||
        assignment.connectionId !== connection.connectionId ||
        assignment.queue !== connection.queue ||
        (assignment.tabSequence ?? -1) > requestSequence
      ) {
        return current;
      }
      const assignments = new Map(current.assignments);
      const closedDifferentExactTab =
        input.operation === "close" &&
        input.tabId !== undefined &&
        assignment.tabId !== undefined &&
        input.tabId !== assignment.tabId;
      // Every branch keeps the per-caller map in step with the group tab, so
      // closing or clearing a tab never leaves a caller pointing at one that
      // is gone -- which would resurrect the collision through the fallback.
      const withoutCaller = () => {
        if (assignment.tabByCaller === undefined) return {};
        const next = new Map(assignment.tabByCaller);
        next.delete(callerKey);
        return next.size === 0 ? {} : { tabByCaller: next };
      };
      const withCaller = (tab: PreviewTabId) => ({
        tabByCaller: new Map(assignment.tabByCaller ?? []).set(callerKey, tab),
      });
      if (closedDifferentExactTab) {
        // Closing some OTHER tab must not disturb what this caller is working
        // in, so its entry is carried through untouched.
        assignments.set(assignmentKey, { ...assignment, tabSequence: requestSequence });
      } else if (resultTabId === null) {
        const { tabId: _tabId, tabByCaller: _dropped, ...withoutTabId } = assignment;
        assignments.set(assignmentKey, {
          ...withoutTabId,
          ...withoutCaller(),
          tabSequence: requestSequence,
        });
      } else {
        assignments.set(assignmentKey, {
          ...assignment,
          tabId: resultTabId,
          ...withCaller(resultTabId),
          tabSequence: requestSequence,
        });
      }
      return { ...current, assignments };
    });
    return yield* withTabHolders(result, assignmentKey, callerKey);
  });

  const manageCredentials: PreviewAutomationBroker["Service"]["manageCredentials"] = Effect.fn(
    "PreviewAutomationBroker.manageCredentials",
  )(function* (input) {
    const timeoutMs = input.timeoutMs ?? CREDENTIAL_VAULT_TIMEOUT_MS;
    const deferred = yield* Deferred.make<unknown, PreviewCredentialVaultError>();
    // Only the desktop running on the environment's own machine: its vault is
    // the one agents' fills read from. Another desktop viewing this
    // environment keeps a different vault on a different computer.
    const route = yield* SynchronizedRef.modify(state, (current) => {
      const connection = Array.from(current.clients.values())
        .filter(
          (host) =>
            host.environmentId === input.environmentId &&
            host.environmentLocal &&
            host.manageCredentials,
        )
        .sort(
          (left, right) =>
            Number(right.focused) - Number(left.focused) || right.focusOrder - left.focusOrder,
        )[0];
      if (!connection) return [undefined, current] as const;
      const requestId = `credential-vault-${current.requestSequence}`;
      const vaultPending = new Map(current.vaultPending);
      vaultPending.set(requestId, {
        queue: connection.queue,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        deferred,
      });
      return [
        { connection, requestId },
        { ...current, vaultPending, requestSequence: current.requestSequence + 1 },
      ] as const;
    });
    if (!route) {
      return yield* credentialVaultError(
        "desktopUnavailable",
        "Saved passwords are kept by the Solla Code desktop app on the computer running this environment, and it isn't connected. Open the desktop app there, then try again.",
      );
    }
    const { connection, requestId } = route;
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.vaultPending.has(requestId)) return next;
      const vaultPending = new Map(next.vaultPending);
      vaultPending.delete(requestId);
      return { ...next, vaultPending };
    });
    const expiresAt = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + timeoutMs;
    const result = yield* Effect.gen(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        type: "credentialVault",
        connectionId: connection.connectionId,
        request: { requestId, command: input.command, expiresAt },
      });
      if (!offered) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) return yield* completion.value;
        return yield* desktopDisconnectedError();
      }
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOption(timeoutMs + BROKER_DEADLINE_MARGIN_MS),
      Effect.ensuring(removePending),
    );
    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(
          credentialVaultError("timeout", "The desktop app didn't answer in time. Try again."),
        ),
      onSome: Effect.succeed,
    });
  });

  return PreviewAutomationBroker.of({ connect, focusHost, respond, invoke, manageCredentials });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);
