/**
 * Meta Muse Code's MSP wire protocol, as this build speaks it.
 *
 * MSP is JSON-RPC 2.0 over the stdio of a long-lived `muse serve` host. Unlike
 * the CLIs whose transcripts we reverse-engineer, Muse ships its own schema:
 * `muse schema generate-ts --out DIR` writes types that are precomputed at
 * build time and exact for that binary. Everything here is derived from that
 * export plus a live handshake against `muse serve`, because four of the rules
 * below are enforced by the binary and stated nowhere in the schema.
 *
 * Verified against Muse Code 1.1.1 (1.1.1-R2514.1), schema version 1,
 * fingerprint sha256:c669a30c…3e6a4f.
 */

import * as NodeCrypto from "node:crypto";
import { ProviderDriverKind, type ToolLifecycleItemType } from "@t3tools/contracts";

export const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");

/** Default binary name; the launcher installs to `~/.local/bin/muse`. */
export const MUSE_DEFAULT_BINARY = "muse";

/** One command, straight from the product page. */
export const MUSE_INSTALL_COMMAND = "curl -fsSL https://dev.meta.ai/install.sh | bash";

/**
 * The client identifier sent in `initialize`.
 *
 * MSP rejects anything outside `^[a-z0-9_]+$` (SS1.4.1) with `invalidParams`,
 * so the product's own name — "solla-code" — is not a legal value. The hyphen
 * is the whole problem; this is the underscored spelling.
 */
export const MUSE_CLIENT_NAME = "solla_code";

/**
 * Schema fingerprint this adapter was written against.
 *
 * Muse self-updates, and a silently changed wire schema is the failure mode
 * that bit the Codex app-server bindings. The adapter logs a warning rather
 * than refusing to run: a fingerprint change usually means new optional
 * members, not a break.
 */
export const MUSE_VERIFIED_SCHEMA_FINGERPRINT =
  "sha256:c669a30c2ee17d63192b227865b424d1d78b5d6c04d9f1c9e9b77b9cf03e6a4f";

/**
 * A UUIDv7, which MSP requires for every `commandId`.
 *
 * `crypto.randomUUID()` is v4 and is rejected outright ("expected UUIDv7"), so
 * this cannot use the platform generator. Layout is the RFC 9562 one: 48 bits
 * of big-endian milliseconds, version 7 in the high nibble of byte 6, and the
 * RFC 4122 variant in byte 8. The remaining bits are random, which also makes
 * these ids sort by creation time — the property MSP's idempotency handles
 * rely on.
 *
 * The epoch milliseconds are passed in rather than read here: this codebase
 * reaches time through Effect's Clock, never `Date.now()`.
 */
export function museCommandId(now: number): string {
  const bytes = NodeCrypto.randomBytes(16);
  const timestamp = BigInt(now);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isMuseCommandId(value: string): boolean {
  return UUID_V7.test(value);
}

/**
 * Arguments for the session host.
 *
 * `--no-session-log` is deliberately absent and must stay absent. A
 * memory-only host accepts `turn/start` and returns a turnId, but then serves
 * no view plane at all: no `turn/started`, no `item/*`, no `turn/completed`,
 * and `view/subscribe` answers `methodNotFound`. The turn runs invisibly and
 * the work log stays empty for its whole duration — the same class of silence
 * that made Deep Code's first build show no tool calls.
 */
export function museServeArgs(input: { readonly trustWorkspace?: boolean } = {}): string[] {
  const args = ["serve"];
  if (input.trustWorkspace !== false) {
    args.push("--trust-workspace");
  }
  return args;
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

export interface MuseRequestFrame {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface MuseNotificationFrame {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type MuseResponseFrame = { readonly jsonrpc: "2.0"; readonly id: number | string } & (
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } }
);

export type MuseIncoming =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | {
      readonly kind: "error";
      readonly id: number;
      readonly code: number;
      readonly message: string;
      readonly errorKind: string | null;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly kind: "request";
      readonly id: number | string;
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | { readonly kind: "unparseable"; readonly line: string };

export function encodeMuseFrame(
  frame: MuseRequestFrame | MuseNotificationFrame | MuseResponseFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Parse one line of the host's stdout.
 *
 * A host that is mid-shutdown, or a launcher that prints a diagnostic, can put
 * a non-JSON line on the same stream; that is reported rather than thrown so
 * the connection survives it.
 */
export function parseMuseLine(line: string): MuseIncoming | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unparseable", line: trimmed };
  }
  return parseMuseMessage(parsed, trimmed);
}

/**
 * Classify an already-decoded MSP frame.
 *
 * The adapter reads stdout through an NDJSON channel, so it holds parsed
 * values rather than lines; {@link parseMuseLine} is the same logic for a raw
 * line.
 */
export function parseMuseMessage(value: unknown, source = ""): MuseIncoming | null {
  const message = asRecord(value);
  const id = message["id"];
  const method = message["method"];
  if (typeof method === "string") {
    if (id === undefined || id === null) {
      return { kind: "notification", method, params: asRecord(message["params"]) };
    }
    if (typeof id === "number" || typeof id === "string") {
      return { kind: "request", id, method, params: asRecord(message["params"]) };
    }
  }
  if (typeof id !== "number") {
    return { kind: "unparseable", line: source };
  }
  const error = message["error"];
  if (error !== undefined && error !== null) {
    const errorRecord = asRecord(error);
    const data = asRecord(errorRecord["data"]);
    const errorKind = data["kind"];
    return {
      kind: "error",
      id,
      code: typeof errorRecord["code"] === "number" ? (errorRecord["code"] as number) : -1,
      message:
        typeof errorRecord["message"] === "string"
          ? (errorRecord["message"] as string)
          : "muse request failed",
      errorKind: typeof errorKind === "string" ? errorKind : null,
    };
  }
  return { kind: "result", id, result: message["result"] };
}

/**
 * Split a stdout chunk into whole lines, returning the unterminated remainder.
 *
 * MSP frames are newline-delimited JSON, and a frame carrying a long tool
 * output routinely spans several chunk boundaries.
 */
export function splitMuseLines(buffered: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const lines: string[] = [];
  let rest = buffered;
  let index = rest.indexOf("\n");
  while (index >= 0) {
    lines.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
    index = rest.indexOf("\n");
  }
  return { lines, rest };
}

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/** MSP's reasoning tiers, from the generated `ReasoningEffort`. */
export const MUSE_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type MuseReasoningEffort = (typeof MUSE_REASONING_EFFORTS)[number];

/**
 * Map Solla's effort onto Muse's tiers.
 *
 * Muse has eight tiers to our four, so the mapping is deliberate rather than
 * positional: `max` takes Muse's `max` rather than `ultra`, because `ultra`
 * is a tier above anything the other providers expose and picking it would
 * make "max" mean something different here than everywhere else.
 */
export function museReasoningEffort(effort: string | undefined): MuseReasoningEffort | undefined {
  switch (effort) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    // Spelled identically in both vocabularies, so passing it through is not a
    // mapping choice. Left out, an explicit "Extra High" silently became the
    // host's own default and the setting did nothing.
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

/**
 * The reasoning tiers the picker offers for a Muse model.
 *
 * Exactly the set `museReasoningEffort` can express, in the host's order, so
 * the picker never shows a tier that quietly resolves to something else. Muse
 * models come from the account's own catalog and carry no capabilities of
 * their own, which is why they had no reasoning control at all: the tier
 * reached the CLI only when something else had already set it.
 *
 * `high` is marked default because that is the binary's own default
 * (`--reasoning-effort ... (default: high)`), so the picker opens on what an
 * unset session would actually do.
 */
export const MUSE_EFFORT_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** `ItemKind` from the generated schema. */
export type MuseItemKind =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "toolCall"
  | "userShell"
  | "subagent"
  | "workflow"
  | "reminderChild"
  | "compaction"
  | (string & {});

/** `ItemStatus` from the generated schema. */
export type MuseItemStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "timedOut"
  | (string & {});

export interface MuseItem {
  readonly itemId: string;
  readonly kind: MuseItemKind;
  readonly status: MuseItemStatus;
  readonly revision: number;
  readonly text?: string;
  readonly summary?: ReadonlyArray<string>;
  readonly tool?: string;
  readonly args?: string;
  readonly commandText?: string;
  readonly visibleOutput?: string;
  readonly failureReason?: string;
  readonly objective?: string;
  readonly turnId?: string | null;
}

/**
 * Map a Muse tool name onto the timeline's coarse lifecycle type.
 *
 * Muse names its tools plainly (`shell`, `read_file`, `apply_patch`,
 * `web_search`, `mcp__…`). Anything unrecognised stays `dynamic_tool_call`
 * rather than claiming a command ran or a file changed.
 */
export function classifyMuseToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("subagent") || normalized.includes("agent"))
    return "collab_agent_tool_call";
  if (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("exec") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  )
    return "command_execution";
  if (normalized.includes("web") && normalized.includes("search")) return "web_search";
  if (normalized.includes("fetch") || normalized.includes("browse")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("patch") ||
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("apply")
  )
    return "file_change";
  return "dynamic_tool_call";
}

/** A human label for a tool lifecycle row. */
export function museToolTitle(itemType: ToolLifecycleItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image";
    case "mcp_tool_call":
      return "MCP tool";
    case "collab_agent_tool_call":
      return "Agent";
    default:
      return "Tool";
  }
}

const TOOL_DETAIL_MAX_CHARS = 400;

/**
 * A thought is prose the user reads, so it carries the same generous bound the
 * ingestion layer applies. A tighter value here would silently become the real
 * cap and put a "..." back in the middle of the transcript.
 */
export const MUSE_REASONING_MAX_CHARS = 16_000;

export function boundMuseText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The one-line detail for a tool row: the command when there is one, otherwise
 * the arguments the model passed.
 */
export function museToolDetail(item: MuseItem): string | undefined {
  const command = item.commandText?.trim();
  if (command && command.length > 0) {
    return boundMuseText(command, TOOL_DETAIL_MAX_CHARS);
  }
  const args = item.args?.trim();
  if (args && args.length > 0) {
    return boundMuseText(args, TOOL_DETAIL_MAX_CHARS);
  }
  const objective = item.objective?.trim();
  if (objective && objective.length > 0) {
    return boundMuseText(objective, TOOL_DETAIL_MAX_CHARS);
  }
  return undefined;
}

/**
 * The text a reasoning item is currently showing.
 *
 * MSP streams reasoning either as `text` or as an ordered `summary` array
 * whose entries are appended through `item/delta` with a dotted field path
 * (`summary.0`). Joining the summary preserves the model's own paragraphing.
 */
export function museReasoningText(item: MuseItem): string {
  const summary = item.summary?.map((part) => part.trim()).filter((part) => part.length > 0) ?? [];
  if (summary.length > 0) {
    return boundMuseText(summary.join("\n\n"), MUSE_REASONING_MAX_CHARS);
  }
  return boundMuseText(item.text?.trim() ?? "", MUSE_REASONING_MAX_CHARS);
}

/** Whether a terminal MSP item status means the tool failed. */
export function museItemFailed(status: MuseItemStatus): boolean {
  return status === "failed" || status === "timedOut" || status === "rejected";
}

/** Whether an MSP item status is terminal at all. */
export function museItemSettled(status: MuseItemStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rejected" ||
    status === "timedOut"
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface MuseModelCatalogEntry {
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  /**
   * Whether this row is the *session's currently selected model*.
   *
   * Not an entitlement flag, however much the name reads like one. The MSP
   * schema is explicit: it "marks the session's effective model when
   * `sessionId` was supplied. May be false for every row - a client MUST NOT
   * assume exactly one." `model/list` is called here without a `sessionId`,
   * so it is `false` on every row of every response, always.
   *
   * Reading it as "the account may run this model" is what reported a
   * working, signed-in account as having no Muse plan and left the picker
   * empty while the same account ran `muse-spark-1.3-contributor` in a
   * terminal. Nothing outside this module may filter on it.
   */
  readonly isSessionSelected: boolean;
  readonly isDefault: boolean;
  /**
   * Per-1M-token catalog prices, verbatim decimal strings as the host serves
   * them (MSP tdd SS3.10: "never rounded or re-formatted by the host. Cost
   * arithmetic stays client-local view math"). Absent when the catalog source
   * declared nothing.
   */
  readonly cost?: MuseModelCost;
}

export interface MuseModelCost {
  readonly input: string;
  readonly output: string;
  readonly cachedInput?: string;
  readonly currency: string;
}

function decimalField(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? value.trim()
    : undefined;
}

/**
 * The catalog's cost block, or nothing.
 *
 * Both input and output prices are required to price anything; a block with
 * only one is treated as no price rather than as a zero for the other.
 */
export function museModelCostFrom(raw: unknown): MuseModelCost | undefined {
  const cost = asRecord(raw);
  const input = decimalField(cost["input"]);
  const output = decimalField(cost["output"]);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = decimalField(cost["cachedInput"]);
  const currency = typeof cost["currency"] === "string" ? cost["currency"] : "USD";
  return { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}), currency };
}

/**
 * What one model completion cost, in the catalog's currency.
 *
 * This is the arithmetic Muse's own `/cost` command does, done here for the
 * usage strip: the per-1M prices from the catalog against the host's
 * counted-once `promptTokens` and the raw `outputTokens`. Cached prompt
 * tokens are priced at the cached rate when the catalog has one and at the
 * input rate when it does not -- over-reporting a little rather than calling
 * cached tokens free, which no catalog says. `promptTokens` already contains
 * the cached tokens under whichever cache convention the provider uses
 * (#8803), so the uncached share is the difference, floored at zero.
 */
export function museCompletionCost(input: {
  readonly cost: MuseModelCost;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
}): number {
  const cached = Math.max(0, Math.min(input.cachedTokens, input.promptTokens));
  const uncached = Math.max(0, input.promptTokens - cached);
  const cachedRate = Number(input.cost.cachedInput ?? input.cost.input);
  const total =
    uncached * Number(input.cost.input) +
    cached * cachedRate +
    Math.max(0, input.outputTokens) * Number(input.cost.output);
  return Number.isFinite(total) ? total / 1_000_000 : 0;
}

/**
 * Models the host reports, normalized for the picker.
 *
 * `model/list` is the only source: Muse's catalog is served by the account and
 * comes back **empty when signed out**. Inventing ids to fill that gap is the
 * `nimbus_quill` mistake, so an empty catalog stays empty and the picker shows
 * the account is not connected.
 */
export function museModelsFromCatalog(result: unknown): ReadonlyArray<MuseModelCatalogEntry> {
  const record = asRecord(result);
  const models = record["models"];
  if (!Array.isArray(models)) {
    return [];
  }
  const entries: MuseModelCatalogEntry[] = [];
  for (const raw of models) {
    const model = asRecord(raw);
    const modelId = model["modelId"] ?? model["id"];
    if (typeof modelId !== "string" || modelId.trim().length === 0) {
      continue;
    }
    // The host's own field names, read off a live catalog: `displayLabel` and
    // `contextLimit`. Guessing `displayName`/`contextWindow` silently produced
    // models labelled with their slug and no context size at all.
    const displayName = model["displayLabel"] ?? model["displayName"];
    const contextWindow = model["contextLimit"] ?? model["contextWindow"];
    const cost = museModelCostFrom(model["cost"]);
    entries.push({
      modelId: modelId.trim(),
      ...(typeof displayName === "string" && displayName.trim().length > 0
        ? { displayName: displayName.trim() }
        : {}),
      ...(typeof contextWindow === "number" && Number.isFinite(contextWindow)
        ? { contextWindow }
        : {}),
      isSessionSelected: model["isActive"] === true,
      isDefault: model["isDefault"] === true,
      ...(cost ? { cost } : {}),
    });
  }
  return entries;
}

/**
 * Parse `muse --version`, which prints `Muse Code 1.1.1 (1.1.1-R2514.1)`.
 */
export function parseMuseVersion(stdout: string): string | null {
  const match = /Muse\s+Code\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  if (match?.[1]) {
    return match[1];
  }
  const fallback = /([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout.trim());
  return fallback?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function homeDir(environment: NodeJS.ProcessEnv): string {
  return environment["HOME"] ?? environment["USERPROFILE"] ?? "";
}

/** Where the CLI keeps its own configuration, including credentials. */
export function museConfigDir(environment: NodeJS.ProcessEnv): string {
  const configHome = environment["XDG_CONFIG_HOME"];
  if (configHome && configHome.trim().length > 0) {
    return `${configHome}/muse`;
  }
  return `${homeDir(environment)}/.config/muse`;
}

/**
 * The credential file `muse login` writes.
 *
 * `auth.json`, with no leading dot. The dotted name belongs to the lock file
 * that sits beside it (`.auth.json.lock`), which exists from the CLI's first
 * run and so says nothing about whether anyone has signed in - reading that
 * one reports every account as signed out forever.
 *
 * Only its existence is read. Nothing here can create it, so the probe points
 * at `muse login` rather than offering an in-app flow it cannot complete.
 */
export function museAuthFilePath(environment: NodeJS.ProcessEnv): string {
  return `${museConfigDir(environment)}/auth.json`;
}

/**
 * Where to send someone who needs a Muse plan.
 *
 * Muse's own CLI prints an Accounts Center deep link
 * (`accountscenter.meta.com/muse_code/`), but that URL only resolves for a
 * browser already signed in to Meta: signed out it bounces through an OIDC
 * login that dead-ends in a 404, which is what a person tapping this on a
 * phone actually hits. The product page needs no login, lists the same plans
 * with their prices, and carries Meta's own sign-up path - so it is the link
 * that works for everyone rather than the one that reads more official.
 */
export const MUSE_PLAN_URL = "https://developer.meta.com/ai/lp/muse-code/";
