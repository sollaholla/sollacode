/**
 * Antigravity CLI (`agy`) stream-json wire protocol.
 *
 * `agy --input-format stream-json --output-format stream-json -p=""` is a
 * long-lived bidirectional session: one NDJSON object per line in on stdin,
 * one NDJSON event per line out on stdout, and closing stdin ends the session
 * with exit 0. That is the same shape the other CLI-backed drivers use, so it
 * maps onto `ProviderAdapter` without a side channel.
 *
 * Everything here is derived from the live binary (v1.1.24), not from the
 * docs, because the two disagree in three places that would each have shipped
 * a bug:
 *
 *   1. `conversation_id` sits on the **top-level envelope** of `init`, but
 *      **inside the payload** of `step_update` and `result`. A parser that
 *      reads one location loses the session id for the other events.
 *   2. Framing errors (`missing "event" field`, bad JSON) are reported as a
 *      normal `result` event on **stdout** with `status: "ERROR"` — the docs
 *      say diagnostics go to stderr. In stream-json mode stderr stayed empty.
 *   3. `-p` takes the *next token* as its prompt, so `-p --input-format …`
 *      silently consumes the flag. The empty-value form `-p=""` is the only
 *      way to start a stdin-driven session. See `buildAntigravityStreamArgs`.
 *
 * @module provider/antigravityProtocol
 */

/** Terminal and transient run states reported by `result.status`. */
export type AntigravityRunStatus =
  | "SUCCESS"
  | "ERROR"
  | "CANCELED"
  | "INTERRUPTED"
  | "INVALID"
  | "WAITING"
  | "RUNNING";

const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
]);

/**
 * Whether a `result` status means the turn stopped without completing.
 *
 * `WAITING` and `RUNNING` are deliberately absent: they are progress states,
 * and treating them as failure would end a turn that is still working.
 */
export function isAntigravityFailureStatus(status: string): boolean {
  return TERMINAL_FAILURE_STATUSES.has(status);
}

export interface AntigravityUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
}

export interface AntigravityToolInfo {
  readonly name: string | null;
  readonly parameters: unknown;
  readonly output: unknown;
  readonly errorType: string | null;
  readonly errorMessage: string | null;
}

export interface AntigravitySubagent {
  readonly typeName: string | null;
  readonly role: string | null;
  readonly conversationId: string | null;
  readonly logUri: string | null;
  readonly workspaceUris: ReadonlyArray<string>;
}

export interface AntigravityInitEvent {
  readonly kind: "init";
  readonly conversationId: string | null;
  readonly model: string | null;
  readonly agent: string | null;
  readonly cwd: string | null;
  readonly tools: ReadonlyArray<string>;
  readonly permissionMode: string | null;
}

export interface AntigravityStepUpdateEvent {
  readonly kind: "step_update";
  readonly conversationId: string | null;
  readonly stepIndex: number | null;
  /** `ACTIVE` while the step is streaming, `DONE` on its final frame. */
  readonly state: string | null;
  /** Observed: `user_input`, `agent_response`, `tool`, `checkpoint`. */
  readonly stepType: string | null;
  readonly toolName: string | null;
  readonly textDelta: string | null;
  readonly durationSeconds: number | null;
  readonly usage: AntigravityUsage | null;
  readonly toolInfo: AntigravityToolInfo | null;
  readonly subagents: ReadonlyArray<AntigravitySubagent>;
}

export interface AntigravityResultEvent {
  readonly kind: "result";
  readonly conversationId: string | null;
  readonly status: string | null;
  readonly response: string | null;
  readonly error: string | null;
  readonly durationSeconds: number | null;
  readonly numTurns: number | null;
  readonly structuredOutput: unknown;
  readonly usage: AntigravityUsage | null;
}

/**
 * An event whose `event` name this build does not model.
 *
 * Deliberately not an error. `agy` ships independently of us and adds event
 * types between releases; failing the stream on an unrecognised name would
 * kill a live turn over a field nothing reads. Display data degrades, it does
 * not throw — the strictness belongs on decisions that destroy work, not on
 * rendering.
 */
export interface AntigravityUnknownEvent {
  readonly kind: "unknown";
  readonly event: string | null;
  readonly raw: unknown;
}

/** A line that was not JSON at all, kept so callers can log it verbatim. */
export interface AntigravityMalformedLine {
  readonly kind: "malformed";
  readonly line: string;
}

export type AntigravityEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | AntigravityUnknownEvent
  | AntigravityMalformedLine;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  // NaN/Infinity would poison duration and token arithmetic downstream.
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const out: Array<string> = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function parseUsage(value: unknown): AntigravityUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    inputTokens: asNumber(record["input_tokens"]) ?? 0,
    outputTokens: asNumber(record["output_tokens"]) ?? 0,
    thinkingTokens: asNumber(record["thinking_tokens"]) ?? 0,
    cacheReadTokens: asNumber(record["cache_read_tokens"]) ?? 0,
    totalTokens: asNumber(record["total_tokens"]) ?? 0,
  };
}

function parseToolInfo(value: unknown): AntigravityToolInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const error = asRecord(record["error"]);
  return {
    name: asString(record["name"]),
    parameters: record["parameters"],
    output: record["output"],
    errorType: error === null ? null : asString(error["type"]),
    errorMessage: error === null ? null : asString(error["message"]),
  };
}

function parseSubagents(value: unknown): ReadonlyArray<AntigravitySubagent> {
  const record = asRecord(value);
  if (record === null) return [];
  const raw = record["subagents"];
  if (!Array.isArray(raw)) return [];
  const out: Array<AntigravitySubagent> = [];
  for (const entry of raw) {
    const subagent = asRecord(entry);
    if (subagent === null) continue;
    out.push({
      typeName: asString(subagent["type_name"]),
      role: asString(subagent["role"]),
      conversationId: asString(subagent["conversation_id"]),
      logUri: asString(subagent["log_uri"]),
      workspaceUris: asStringArray(subagent["workspace_uris"]),
    });
  }
  return out;
}

/**
 * Decode one NDJSON line.
 *
 * Never throws. A line this build cannot classify comes back as `unknown` or
 * `malformed` so the caller can keep the session alive and log it.
 */
export function parseAntigravityEventLine(line: string): AntigravityEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "malformed", line: trimmed };
  }
  const envelope = asRecord(parsed);
  if (envelope === null) return { kind: "malformed", line: trimmed };
  const event = asString(envelope["event"]);

  if (event === "init") {
    const payload = asRecord(envelope["init"]) ?? {};
    return {
      kind: "init",
      // Top-level on this event only — see the module note.
      conversationId: asString(envelope["conversation_id"]),
      model: asString(payload["model"]),
      agent: asString(payload["agent"]),
      cwd: asString(payload["cwd"]),
      tools: asStringArray(payload["tools"]),
      permissionMode: asString(payload["permission_mode"]),
    };
  }

  if (event === "step_update") {
    const payload = asRecord(envelope["step_update"]) ?? {};
    return {
      kind: "step_update",
      conversationId: asString(payload["conversation_id"]),
      stepIndex: asNumber(payload["step_index"]),
      state: asString(payload["state"]),
      stepType: asString(payload["step_type"]),
      toolName: asString(payload["tool_name"]),
      textDelta: asString(payload["text_delta"]),
      durationSeconds: asNumber(payload["duration_seconds"]),
      usage: parseUsage(payload["usage"]),
      toolInfo: parseToolInfo(payload["tool_info"]),
      subagents: parseSubagents(payload["subagent_info"]),
    };
  }

  if (event === "result") {
    const payload = asRecord(envelope["result"]) ?? {};
    return {
      kind: "result",
      conversationId: asString(payload["conversation_id"]),
      status: asString(payload["status"]),
      response: asString(payload["response"]),
      error: asString(payload["error"]),
      durationSeconds: asNumber(payload["duration_seconds"]),
      numTurns: asNumber(payload["num_turns"]),
      structuredOutput: payload["structured_output"],
      usage: parseUsage(payload["usage"]),
    };
  }

  return { kind: "unknown", event, raw: parsed };
}

/**
 * Splits a byte stream into NDJSON lines across chunk boundaries.
 *
 * stdout arrives in arbitrary chunks, so a line can be cut in half. Parsing
 * per-chunk would classify the halves as `malformed` and drop a real event.
 */
export class AntigravityLineFramer {
  private buffer = "";

  /** Complete lines contained in this chunk; the remainder is retained. */
  push(chunk: string): ReadonlyArray<string> {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    // The last element is either "" (chunk ended on a newline) or a partial
    // line that must wait for more bytes.
    this.buffer = parts.pop() ?? "";
    return parts;
  }

  /**
   * Whatever is left when the stream ends.
   *
   * `agy` terminates its final line, but a process killed mid-write does not,
   * and that trailing line is often the `result` carrying the failure reason.
   */
  flush(): ReadonlyArray<string> {
    const remainder = this.buffer;
    this.buffer = "";
    return remainder.trim().length === 0 ? [] : [remainder];
  }
}

/** One assistant-visible step, folded from its `step_update` frames. */
export interface AntigravityStep {
  readonly stepIndex: number;
  readonly stepType: string | null;
  readonly text: string;
  readonly toolName: string | null;
  readonly toolInfo: AntigravityToolInfo | null;
  readonly subagents: ReadonlyArray<AntigravitySubagent>;
  readonly done: boolean;
  readonly usage: AntigravityUsage | null;
  readonly durationSeconds: number | null;
}

/**
 * Folds `step_update` frames into steps, keyed by `step_index`.
 *
 * The trap this exists to avoid: **the `DONE` frame carries a `text_delta`
 * too.** Ground truth for a one-word reply is
 * `index 1 ACTIVE "OK"` then `index 1 DONE "\n"`. Treating `DONE` as a
 * terminator rather than a frame that also appends drops the tail of every
 * single message — a corruption that looks like the model trailing off, and
 * that a test asserting only "the text starts with OK" would pass.
 */
export class AntigravityTurnAccumulator {
  private readonly steps = new Map<number, AntigravityStep>();
  private conversationId: string | null = null;

  observe(event: AntigravityEvent): void {
    if (event.kind === "init") {
      if (event.conversationId !== null) this.conversationId = event.conversationId;
      return;
    }
    if (event.kind === "result") {
      if (event.conversationId !== null) this.conversationId = event.conversationId;
      return;
    }
    if (event.kind !== "step_update") return;
    if (event.conversationId !== null) this.conversationId = event.conversationId;
    // A frame with no index cannot be folded into a step without merging
    // unrelated output; drop it rather than guess which step it belongs to.
    if (event.stepIndex === null) return;

    const previous = this.steps.get(event.stepIndex);
    this.steps.set(event.stepIndex, {
      stepIndex: event.stepIndex,
      stepType: event.stepType ?? previous?.stepType ?? null,
      // Append on every frame, DONE included.
      text: (previous?.text ?? "") + (event.textDelta ?? ""),
      toolName: event.toolName ?? previous?.toolName ?? null,
      toolInfo: event.toolInfo ?? previous?.toolInfo ?? null,
      subagents: event.subagents.length > 0 ? event.subagents : (previous?.subagents ?? []),
      // Latch: a later frame for the same index must not un-finish it.
      done: previous?.done === true || event.state === "DONE",
      usage: event.usage ?? previous?.usage ?? null,
      durationSeconds: event.durationSeconds ?? previous?.durationSeconds ?? null,
    });
  }

  /** Steps in `step_index` order — Map insertion order is arrival order, not index order. */
  snapshot(): ReadonlyArray<AntigravityStep> {
    return [...this.steps.values()].sort((a, b) => a.stepIndex - b.stepIndex);
  }

  currentConversationId(): string | null {
    return this.conversationId;
  }

  /** Concatenated assistant prose, excluding tool and bookkeeping steps. */
  assistantText(): string {
    return this.snapshot()
      .filter((step) => step.stepType === "agent_response")
      .map((step) => step.text)
      .join("");
  }
}

/**
 * Argv for a persistent stdin-driven session.
 *
 * Two traps, both found by running the real binary rather than reading docs
 * (agy v1.1.24):
 *
 *   1. `-p` is not a boolean — it consumes the next token as its prompt, so
 *      `["-p", "--input-format", …]` makes the CLI treat `--input-format` as
 *      the prompt, and a trailing bare `-p` exits 2 with "flag needs an
 *      argument". The value must be attached.
 *   2. The value must be a genuinely **empty string**: `-p=`, not `-p=""`.
 *      Interactively a shell strips those quotes, so `-p=""` appears to work
 *      when typed; passed through `spawn` there is no shell, the CLI receives
 *      a two-character literal `""` as the prompt, and rejects it with exit 2
 *      ("--input-format stream-json reads prompts from stdin, so a prompt
 *      given on the command line would be ignored"). Shell-tested argv is not
 *      evidence for spawned argv.
 */
export function buildAntigravityStreamArgs(input: {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly agent?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly skipPermissions?: boolean | undefined;
  readonly addDirs?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const args: Array<string> = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (input.model !== undefined && input.model.length > 0) args.push("--model", input.model);
  if (input.effort !== undefined && input.effort.length > 0) args.push("--effort", input.effort);
  if (input.agent !== undefined && input.agent.length > 0) args.push("--agent", input.agent);
  if (input.conversationId !== undefined && input.conversationId.length > 0) {
    args.push("--conversation", input.conversationId);
  }
  if (input.skipPermissions === true) args.push("--dangerously-skip-permissions");
  for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
  // Must come last, and the value must be an empty string, not quoted.
  args.push("-p=");
  return args;
}

/**
 * One stdin line carrying a user turn.
 *
 * `content` accepts a bare string or text blocks, and `text` is the only block
 * type the CLI permits — a non-text block exits 1 and ends the session, so
 * attachments must be rendered into text before they get here rather than
 * passed through as blocks.
 */
export function encodeAntigravityUserMessage(text: string): string {
  return JSON.stringify({ event: "user", message: { content: text } });
}

/** One entry from `agy models`. */
export interface AntigravityModel {
  readonly slug: string;
  readonly label: string;
}

/**
 * Parses `agy models`, which prints `<slug>\t<label>` per line.
 *
 * Two shapes have to survive here. The command writes a human status line
 * first (`Fetching available models...`), and that line has no tab — so
 * "skip the first line" is the wrong rule (it would eat a real model if the
 * status line ever moves or disappears). Requiring a tab is the rule that
 * holds either way.
 *
 * Slugs frequently embed a reasoning level (`gemini-3.8-flash-low`) even
 * though `--effort` exists as its own flag, so the two are not redundant and
 * this parser must not try to strip or normalise the suffix — the CLI
 * validates the pair and exits 1 on a combination it does not recognise.
 */
export function parseAntigravityModelsOutput(stdout: string): ReadonlyArray<AntigravityModel> {
  const models: Array<AntigravityModel> = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    // Strip only the CR of a CRLF line ending. A general `trimEnd()` would
    // also remove the separating tab of a row whose label is empty, making it
    // indistinguishable from the untabbed status banner and dropping the model.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug, label: label.length > 0 ? label : slug });
  }
  return models;
}
