import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OPENAI_LIVE_MODEL = "gpt-live-1";
export const OPENAI_LIVE_VOICES = [
  "marin",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
] as const;
export const ORCHESTRATOR_LIVE_SESSION_PATH = "/api/orchestrator/live/session";
export const ORCHESTRATOR_LIVE_DELEGATION_PATH = "/api/orchestrator/live/delegation";

export const OrchestratorLiveHistoryEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(4_000)),
});
export const OrchestratorLiveStartInput = Schema.Struct({
  sdp: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  history: Schema.Array(OrchestratorLiveHistoryEntry).check(Schema.isMaxLength(24)),
});
export type OrchestratorLiveStartInput = typeof OrchestratorLiveStartInput.Type;
export const OrchestratorLiveStartResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  sdp: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  voice: TrimmedNonEmptyString,
  agentName: TrimmedNonEmptyString,
});
export const OrchestratorLiveDelegationInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  delegationId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sequence: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(256),
  ),
  context: TrimmedNonEmptyString.check(Schema.isMaxLength(24_000)),
});
export type OrchestratorLiveDelegationInput = typeof OrchestratorLiveDelegationInput.Type;
/** One NDJSON event per durable work revision, ending with a terminal status. */
export const OrchestratorLiveWorkEvent = Schema.Struct({
  delegationId: TrimmedNonEmptyString,
  status: Schema.Literals([
    "pending-approval",
    "queued",
    "running",
    "waiting-input",
    "completed",
    "failed",
    "cancelled",
    "expired",
  ]),
  text: Schema.String,
});
export type OrchestratorLiveWorkEvent = typeof OrchestratorLiveWorkEvent.Type;
