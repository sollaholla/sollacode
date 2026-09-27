// @effect-diagnostics nodeBuiltinImport:off
/**
 * Deep Code CLI helpers: exec argv, session-index parsing, and settings auth.
 *
 * Headless turns are `deepcode --exec --prompt`. The CLI writes the final
 * assistant reply to stdout and persists the native session under
 * `~/.deepcode/projects/<projectCode>/sessions-index.json`.
 *
 * @module provider/deepcodeProtocol
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { ServerProviderModel } from "@t3tools/contracts";

const MAX_PROJECT_CODE_LENGTH = 64;
const PROJECT_CODE_HASH_LENGTH = 16;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEEPCODE_EFFORTS = ["low", "high", "max"] as const;
export type DeepCodeEffort = (typeof DEEPCODE_EFFORTS)[number];

export const DEEPCODE_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      currentValue: "max",
      options: [
        { id: "low", label: "Low", isDefault: false },
        { id: "high", label: "High", isDefault: false },
        { id: "max", label: "Max", isDefault: true },
      ],
    },
  ],
});

/**
 * The Deep Code models, named for the version each slug actually serves.
 *
 * DeepSeek publishes stable slugs and moves the model behind them, so the slug
 * is not the version. `deepseek-flash` is served by DeepSeek-V4.1-Flash and is
 * the name DeepSeek documents for current use, which is why it is the default.
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired aliases —
 * DeepSeek routes them to the same V4.1 Flash model and bills them at Flash
 * rates — so they are not offered as choices; `MODEL_SLUG_ALIASES_BY_PROVIDER`
 * maps a previously saved selection onto `deepseek-flash`. There is also no
 * separate image model to offer: `--exec` takes one text prompt, so image
 * attachments reach the agent as on-disk paths (see DeepCodeAdapter.sendTurn).
 *
 * Adding a `deepseek-v4.1-*` slug would be wrong: no such slug exists, and an
 * unrecognised model id must never reach the picker.
 */
export const DEEPCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    isCustom: false,
    isDefault: true,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    isDefault: false,
    capabilities: DEEPCODE_MODEL_CAPABILITIES,
  },
];

export function isDeepCodeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isDeepCodeEffort(value: string): value is DeepCodeEffort {
  return (DEEPCODE_EFFORTS as ReadonlyArray<string>).includes(value);
}

/** Match Deep Code's project folder name under `~/.deepcode/projects`. */
export function deepCodeProjectCode(
  projectRoot: string,
  // eslint-disable-next-line t3code/no-global-process-runtime -- Mirrors the CLI's own folder naming on the host it runs on, like NodePath.resolve below; tests pass the platform.
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedRoot = NodePath.resolve(projectRoot);
  const legacyCode = normalizedRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
  if (legacyCode.length <= MAX_PROJECT_CODE_LENGTH) return legacyCode;

  const hashInput = platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const hash = NodeCrypto.createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .slice(0, PROJECT_CODE_HASH_LENGTH);
  const prefixLimit = MAX_PROJECT_CODE_LENGTH - PROJECT_CODE_HASH_LENGTH - 1;
  const prefix =
    sanitizeProjectCodePart(NodePath.basename(normalizedRoot))
      .slice(0, prefixLimit)
      .replace(/[-.]+$/g, "") || "project";
  return `${prefix}-${hash}`;
}

function sanitizeProjectCodePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function deepCodeHomeDir(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || NodeOS.homedir();
}

export function deepCodeSettingsPath(homeDir: string): string {
  return NodePath.join(homeDir, ".deepcode", "settings.json");
}

export function deepCodeSessionsIndexPath(homeDir: string, projectRoot: string): string {
  return NodePath.join(
    homeDir,
    ".deepcode",
    "projects",
    deepCodeProjectCode(projectRoot),
    "sessions-index.json",
  );
}

export interface DeepCodeSessionIndexEntry {
  readonly id: string;
  readonly updateTime: string;
}

export function parseDeepCodeSessionsIndex(raw: string): ReadonlyArray<DeepCodeSessionIndexEntry> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries =
      parsed !== null &&
      typeof parsed === "object" &&
      "entries" in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    const out: DeepCodeSessionIndexEntry[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const id = "id" in entry && typeof entry.id === "string" ? entry.id.trim() : "";
      const updateTime =
        "updateTime" in entry && typeof entry.updateTime === "string" ? entry.updateTime : "";
      if (!isDeepCodeSessionId(id) || updateTime.length === 0) continue;
      out.push({ id, updateTime });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Choose the native session to resume next. Prefer the id we already hold
 * when it is still present; otherwise take the newest entry that appeared or
 * moved forward since the previous snapshot.
 */
export function pickDeepCodeSessionId(input: {
  readonly previous: ReadonlyArray<DeepCodeSessionIndexEntry>;
  readonly next: ReadonlyArray<DeepCodeSessionIndexEntry>;
  readonly resumeSessionId?: string | undefined;
}): string | undefined {
  if (
    input.resumeSessionId &&
    isDeepCodeSessionId(input.resumeSessionId) &&
    input.next.some((entry) => entry.id === input.resumeSessionId)
  ) {
    return input.resumeSessionId;
  }
  const previousById = new Map(input.previous.map((entry) => [entry.id, entry.updateTime]));
  const changed = input.next.filter((entry) => {
    const previous = previousById.get(entry.id);
    return previous === undefined || entry.updateTime > previous;
  });
  const pool = changed.length > 0 ? changed : input.next;
  let newest: DeepCodeSessionIndexEntry | undefined;
  for (const entry of pool) {
    if (!newest || entry.updateTime > newest.updateTime) newest = entry;
  }
  return newest?.id;
}

export function parseDeepCodeSettingsAuth(raw: string): {
  readonly hasApiKey: boolean;
  readonly model: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { hasApiKey: false, model: null };
    }
    const record = parsed as Record<string, unknown>;
    const env =
      record.env !== null && typeof record.env === "object"
        ? (record.env as Record<string, unknown>)
        : {};
    const envKey = typeof env.API_KEY === "string" ? env.API_KEY.trim() : "";
    const envModel = typeof env.MODEL === "string" ? env.MODEL.trim() : "";
    const topModel = typeof record.model === "string" ? record.model.trim() : "";
    return {
      hasApiKey: envKey.length > 0,
      model: topModel || envModel || null,
    };
  } catch {
    return { hasApiKey: false, model: null };
  }
}

/** The full request travels over stdin, outside Windows command-line limits. */
export const DEEPCODE_STDIN_PROMPT =
  "Carry out the user request provided in <stdin>, including its instructions and context.";

export function buildDeepCodeExecArgs(input: {
  readonly resumeSessionId?: string | undefined;
}): string[] {
  const args = ["--exec", "--prompt", DEEPCODE_STDIN_PROMPT];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

export function buildDeepCodeTurnEnvironment(
  base: NodeJS.ProcessEnv,
  input: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...base,
    // The CLI checks previous-request usage, before newly appended tool results.
    // Leave space for those results and for its own compaction request.
    DEEPCODE_AUTO_COMPACT_WINDOW: base.DEEPCODE_AUTO_COMPACT_WINDOW ?? "128K",
  };
  if (input.model) next.DEEPCODE_MODEL = input.model;
  if (input.effort) next.DEEPCODE_REASONING_EFFORT = input.effort;
  return next;
}

export function sessionIdFromCursor(cursor: unknown): string | undefined {
  if (cursor === null || typeof cursor !== "object") return undefined;
  const sessionId =
    "sessionId" in cursor && typeof cursor.sessionId === "string" ? cursor.sessionId.trim() : "";
  return isDeepCodeSessionId(sessionId) ? sessionId : undefined;
}

/**
 * The per-session JSONL the CLI appends one message per line.
 *
 * `--exec` prints only `session.assistantReply`, so this file is the only place
 * a turn's tool calls exist. It sits beside `sessions-index.json`.
 */
export function deepCodeSessionMessagesPath(
  homeDir: string,
  projectRoot: string,
  sessionId: string,
): string {
  return NodePath.join(
    homeDir,
    ".deepcode",
    "projects",
    deepCodeProjectCode(projectRoot),
    `${sessionId}.jsonl`,
  );
}

export interface DeepCodeSessionToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * One persisted session message, reduced to the fields tool activity needs.
 *
 * Assistant messages carry `messageParams.tool_calls`; the matching result is a
 * `role: "tool"` message whose `meta` holds the rendered params and result.
 */
export interface DeepCodeSessionMessage {
  readonly id: string;
  readonly role: string;
  readonly toolCalls: ReadonlyArray<DeepCodeSessionToolCall>;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly paramsMd: string | null;
  readonly resultMd: string | null;
  /** `messageParams.reasoning_content`: the model's thinking for this step. */
  readonly reasoning: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse a Deep Code session JSONL. Malformed lines are ignored, matching the
 * CLI's own tolerant loader, so one truncated write cannot drop the rest.
 */
export function parseDeepCodeSessionMessages(raw: string): ReadonlyArray<DeepCodeSessionMessage> {
  const messages: DeepCodeSessionMessage[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    const messageParams = asRecord(record.messageParams);
    const meta = asRecord(record.meta);
    const metaFunction = asRecord(meta?.function);
    const toolCalls: DeepCodeSessionToolCall[] = [];
    const rawToolCalls = messageParams?.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      for (const entry of rawToolCalls) {
        const call = asRecord(entry);
        const callFunction = asRecord(call?.function);
        const id = recordString(call, "id");
        const name = recordString(callFunction, "name");
        if (!id || !name) continue;
        toolCalls.push({ id, name, arguments: recordString(callFunction, "arguments") ?? "" });
      }
    }
    messages.push({
      id: recordString(record, "id") ?? "",
      role: recordString(record, "role") ?? "",
      toolCalls,
      toolCallId: recordString(messageParams, "tool_call_id"),
      toolName: recordString(metaFunction, "name"),
      paramsMd: recordString(meta, "paramsMd"),
      resultMd: recordString(meta, "resultMd"),
      reasoning: recordString(messageParams, "reasoning_content"),
    });
  }
  return messages;
}

/**
 * The messages appended since the previous turn.
 *
 * A resumed session's JSONL already holds every earlier turn, so replaying it
 * would duplicate their tool calls. Anchor on the last id seen before this
 * turn; when that id is missing (a rewritten or compacted file) return nothing
 * rather than replaying the whole session.
 */
export function newDeepCodeSessionMessages(
  messages: ReadonlyArray<DeepCodeSessionMessage>,
  previousLastMessageId: string | null,
): ReadonlyArray<DeepCodeSessionMessage> {
  if (previousLastMessageId === null) return messages;
  const index = messages.findIndex((message) => message.id === previousLastMessageId);
  return index < 0 ? [] : messages.slice(index + 1);
}

/**
 * Canonical stall marker. The adapter emits this verbatim when its progress
 * watchdog kills a turn whose session file sat unchanged past the limit, and
 * `detectProviderUsageLimitRefusal` matches it by exact equality — never by
 * fuzzy text — because the adapter measured the silence itself and no quota
 * snapshot corroborates it.
 */
export const DEEPCODE_PROGRESS_TIMEOUT_MESSAGE =
  "Deep Code produced no output for 5 minutes, so the stalled request was stopped.";
