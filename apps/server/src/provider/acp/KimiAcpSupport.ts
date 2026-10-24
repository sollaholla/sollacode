import {
  type KimiSettings,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

/**
 * The only auth method `kimi acp` advertises. `authenticate` with it is a pure
 * check of the stored token — it never starts a login, because the stdio
 * channel has no TTY for the device-code prompt — so it is safe to send from a
 * background health check.
 */
const KIMI_AUTH_METHOD_LOGIN = "login";
const KIMI_ACP_FORCE_KILL_AFTER = "2 seconds" as const;
/**
 * `session/new` starts the MCP servers in the user's own `~/.kimi-code/mcp.json`.
 * A hung one must not leave a Solla thread stuck starting.
 */
const KIMI_SESSION_CREATE_TIMEOUT = "45 seconds" as const;
const KIMI_AUTHENTICATE_TIMEOUT = "20 seconds" as const;
const ACP_AUTH_REQUIRED_CODE = -32000;

export const KIMI_NOT_SIGNED_IN_MESSAGE =
  "Kimi Code is not signed in. Run `kimi login` in a terminal, then refresh.";

/**
 * Kimi reports a failed turn (an API error, an exhausted plan, a network
 * outage after its own retries) as an ordinary `end_turn` with no output; the
 * reason only reaches its own log. A turn that produced nothing at all is
 * reported with this instead of settling as a silent success.
 */
export const KIMI_EMPTY_TURN_MESSAGE =
  "Kimi ended the turn without replying. Kimi records the reason only in its own log under ~/.kimi-code (sessions/<workspace>/<session>/logs/kimi-code.log).";

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function kimiBinaryPath(settings: KimiAcpRuntimeKimiSettings | null | undefined): string {
  return settings?.binaryPath?.trim() || "kimi";
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiBinaryPath(kimiSettings),
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
    forceKillAfter: KIMI_ACP_FORCE_KILL_AFTER,
  };
}

/**
 * Builds a `kimi acp` session runtime.
 *
 * No client `fs`/`terminal` capabilities are advertised, so Kimi keeps doing
 * file and shell work in its own process rather than routing it through us.
 */
export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        sessionCreateTimeout: KIMI_SESSION_CREATE_TIMEOUT,
        authenticateTimeout: KIMI_AUTHENTICATE_TIMEOUT,
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: KIMI_AUTH_METHOD_LOGIN,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

/** The ACP SDK's text for `RequestError.authRequired()`, which Kimi sends. */
const ACP_AUTH_REQUIRED_MESSAGE = "Authentication required";

/**
 * Whether a Kimi start or prompt failed because the CLI is signed out.
 *
 * A JSON-RPC error from a real CLI does not always arrive typed: Effect's
 * JSON-RPC decoder turns a plain `{ code, message }` error response into a
 * defect, which keeps the message and drops the code. Both forms count.
 */
export function isKimiAuthRequiredFailure(cause: Cause.Cause<unknown>): boolean {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  if (
    (isAcpRequestError(error) && error.code === ACP_AUTH_REQUIRED_CODE) ||
    ((isAcpRequestError(error) || isAcpTransportError(error)) && error.method === "authenticate")
  ) {
    return true;
  }
  return cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      reason.defect instanceof Error &&
      reason.defect.message === ACP_AUTH_REQUIRED_MESSAGE,
  );
}

// ── Model catalog ─────────────────────────────────────────────────────

export interface KimiCatalogModel {
  /** The alias Kimi sessions accept as the `model` config option value. */
  readonly alias: string;
  readonly displayName: string;
  readonly maxContextSize: number | undefined;
  readonly capabilities: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads the model catalog out of `kimi provider list --json`.
 *
 * That output also carries every provider's `apiKey`, so only the `models`
 * table is read and nothing else from it is kept, logged, or forwarded. An
 * entry without a usable alias is dropped rather than guessed at.
 */
export function parseKimiProviderListJson(stdout: string): ReadonlyArray<KimiCatalogModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.models)) return [];
  const models: Array<KimiCatalogModel> = [];
  for (const [rawAlias, entry] of Object.entries(parsed.models)) {
    const alias = trimmedString(rawAlias);
    if (!alias || !isRecord(entry)) continue;
    const maxContextSize =
      typeof entry.maxContextSize === "number" &&
      Number.isFinite(entry.maxContextSize) &&
      entry.maxContextSize > 0
        ? entry.maxContextSize
        : undefined;
    models.push({
      alias,
      displayName: trimmedString(entry.displayName) ?? alias,
      maxContextSize,
      capabilities: Array.isArray(entry.capabilities)
        ? entry.capabilities.filter((value): value is string => typeof value === "string")
        : [],
    });
  }
  return models;
}

/** Reads `Default model: <alias>` from the plain `kimi provider list` output. */
export function parseKimiDefaultModel(stdout: string): string | undefined {
  const match = /^\s*Default model:\s*(\S+)\s*$/mu.exec(stdout);
  return match?.[1];
}

// ── Session configuration ──────────────────────────────────────────────

/**
 * The Kimi ACP mode for a turn. Kimi has four (`default`, `plan`, `auto`,
 * `yolo`); `auto` also forbids the agent from asking questions, so Solla's
 * auto-approving modes use `yolo`, which keeps questions flowing to the user.
 */
export function kimiModeForTurn(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
}): "default" | "plan" | "yolo" {
  if (input.interactionMode === "plan") return "plan";
  return input.runtimeMode === "full-access" || input.runtimeMode === "auto" ? "yolo" : "default";
}

/** The values a session's select config option currently offers. */
export function kimiSelectOptionValues(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
): ReadonlyArray<string> {
  const option = configOptions.find((candidate) => candidate.id === configId);
  return option ? collectSessionConfigOptionValues(option) : [];
}

// ── Permission requests ────────────────────────────────────────────────

/**
 * Kimi sends three different things through `session/request_permission`,
 * told apart only by the option ids it attaches:
 *
 * - `question`: the AskUserQuestion tool, options `q0_opt_<n>` + `q0_skip`.
 * - `plan-review`: ExitPlanMode, options `plan_opt_<n>` / `plan_approve` /
 *   `plan_revise` / `plan_reject_and_exit`, with the plan as text content.
 * - `approval`: an ordinary tool approval.
 *
 * Every question answer and plan choice is tagged `allow_once`, so treating
 * either as an approval would let an auto-approve pick the user's answer or
 * approve the plan for them.
 */
export type KimiPermissionRequestKind = "question" | "plan-review" | "approval";

const QUESTION_OPTION_ID = /^q\d+_(?:opt_\d+|skip)$/u;
const PLAN_REVIEW_OPTION_ID = /^plan_(?:opt_\d+|approve|revise|reject_and_exit)$/u;

export function classifyKimiPermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): KimiPermissionRequestKind {
  const optionIds = params.options.map((option) => option.optionId);
  if (optionIds.some((id) => PLAN_REVIEW_OPTION_ID.test(id))) return "plan-review";
  if (optionIds.length > 0 && optionIds.every((id) => QUESTION_OPTION_ID.test(id))) {
    return "question";
  }
  return "approval";
}

/**
 * Picks the option that carries a decision, by its ACP `kind`.
 *
 * Kimi's ids (`approve_once`, `approve_always`, `reject`) are not the ones the
 * shared ACP helper sends, and Kimi rejects any id it does not know — so a
 * hardcoded id turned every approval into a rejection. Returns undefined for a
 * cancel, and for a decision the request offers no option for.
 */
export function selectKimiPermissionOptionId(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
  decision: ProviderApprovalDecision,
): string | undefined {
  const byKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    options.find((option) => option.kind === kind)?.optionId;
  switch (decision) {
    case "acceptForSession":
      return byKind("allow_always") ?? byKind("allow_once");
    case "accept":
      return byKind("allow_once") ?? byKind("allow_always");
    case "decline":
      return byKind("reject_once") ?? byKind("reject_always");
    case "cancel":
      return undefined;
  }
}

/** Kimi's own file-writing tools, for `auto-accept-edits`. */
const KIMI_EDIT_TOOL_TITLES = new Set(["Write", "Edit"]);

export function isKimiFileEditPermission(
  params: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return (
    params.toolCall.kind === "edit" ||
    KIMI_EDIT_TOOL_TITLES.has(params.toolCall.title?.trim() ?? "")
  );
}

function permissionTextEntries(params: EffectAcpSchema.RequestPermissionRequest): Array<string> {
  return (params.toolCall.content ?? []).flatMap((entry) =>
    entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
  );
}

export interface KimiQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
  readonly skipOptionId: string | undefined;
}

/** Kimi bridges only the first question of an AskUserQuestion call. */
export function kimiQuestionFromPermission(
  params: EffectAcpSchema.RequestPermissionRequest,
): KimiQuestion {
  const question =
    permissionTextEntries(params)
      .map((text) => text.trim())
      .find((text) => text.length > 0) ?? "Kimi has a question.";
  return {
    question,
    options: params.options
      .filter((option) => /_opt_\d+$/u.test(option.optionId))
      .map((option) => ({ optionId: option.optionId, label: option.name })),
    skipOptionId: params.options.find((option) => option.optionId.endsWith("_skip"))?.optionId,
  };
}

/**
 * The option id answering a question, or undefined to dismiss it.
 *
 * Kimi accepts only one of its own options, so free text the person typed has
 * no way through; it dismisses the question rather than inventing a choice.
 */
export function kimiQuestionAnswerOptionId(
  question: KimiQuestion,
  answer: unknown,
): string | undefined {
  const values = (Array.isArray(answer) ? answer : [answer]).flatMap((value) =>
    typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [],
  );
  for (const value of values) {
    const match = question.options.find((option) => option.label === value);
    if (match) return match.optionId;
  }
  return question.skipOptionId;
}

const PLAN_SAVED_PREFIX = /^Plan saved to: [^\n]*\n\n/u;
const APPROVAL_SUMMARY_PREFIX = "Requesting approval to ";

/** The plan markdown an ExitPlanMode review carries, without Kimi's wrapper lines. */
export function kimiPlanMarkdownFromPermission(
  params: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const text = permissionTextEntries(params).find(
    (entry) => !entry.startsWith(APPROVAL_SUMMARY_PREFIX) && entry.trim().length > 0,
  );
  const plan = text?.replace(PLAN_SAVED_PREFIX, "").trim();
  return plan && plan.length > 0 ? plan : undefined;
}

/**
 * Answers a plan review once Solla has captured the plan.
 *
 * Kimi maps an id it does not know to a plain rejection, and a plain plan
 * rejection is the one outcome that both stops the turn and keeps plan mode
 * active. "Revise" and a dismissal continue the turn, and Kimi's plan mode
 * then calls ExitPlanMode again, so either would loop. The person settles the
 * plan from Solla's plan card, as with every other provider.
 */
export const KIMI_PLAN_CAPTURED_OPTION_ID = "solla_plan_captured";
