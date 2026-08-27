import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DEFAULT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_ORCHESTRATOR_VOICE_PROVIDER,
  OrchestratorVoiceProvider,
} from "./orchestratorVoice.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_SOUND_CUE_VOLUME = 0;
export const MAX_SOUND_CUE_VOLUME = 100;
export const SoundCueVolume = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SOUND_CUE_VOLUME,
    maximum: MAX_SOUND_CUE_VOLUME,
  }),
);
export type SoundCueVolume = typeof SoundCueVolume.Type;
export const DEFAULT_SOUND_CUE_VOLUME: SoundCueVolume = 100;
export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const MIN_AUTO_COMPACTION_THRESHOLD_PERCENTAGE = 50;
export const MAX_AUTO_COMPACTION_THRESHOLD_PERCENTAGE = 95;
export const DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENTAGE = 80;
export const AutoCompactionThresholdPercentage = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AUTO_COMPACTION_THRESHOLD_PERCENTAGE,
    maximum: MAX_AUTO_COMPACTION_THRESHOLD_PERCENTAGE,
  }),
);
export type AutoCompactionThresholdPercentage = typeof AutoCompactionThresholdPercentage.Type;

export const ClientSettingsSchema = Schema.Struct({
  // Master switch for the Agent Stack feature (named autonomous VM agents shown
  // in their own sidebar section below the orchestrator). On by default; turning
  // it off hides the entire surface without deleting any agents.
  agentStackEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Native agent alerts are opt-in per client. Durable in-app alerts remain
  // available when this is off; this controls only operating-system delivery.
  agentDesktopNotificationsEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoSendVoiceTranscription: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  voiceTranscriptionCorrectionEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  voiceTranscriptionCorrectionModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Whether desktop voice capture mutes the machine's output while the user is
  // speaking. Shared by push-to-talk and Orchestrator listening; output is
  // restored while the Orchestrator speaks. The persisted name stays stable.
  pushToTalkMutesSystemAudio: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  sidebarV2Enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Whether `sidebarV2Enabled` reflects an explicit choice in Settings → Beta.
  // Client settings persist as a whole blob, so every user who has ever touched
  // any setting already has `sidebarV2Enabled: false` stored — without this bit
  // there is no way to tell that apart from "left alone", and a channel-derived
  // default could never reach them.
  sidebarV2ConfiguredByUser: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showResumeThreadsOnStartup: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // The synthesized cue tones: the voice orchestrator's state cues and the
  // push-to-talk recording-start blip. One switch for both, because to the
  // user they are one vocabulary. Per-device deliberately — how loud a cue
  // should be depends on the machine it plays from.
  soundCues: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  soundCueVolume: SoundCueVolume.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SOUND_CUE_VOLUME)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const MIN_ATTACHMENT_RETENTION_HOURS = 1;
export const MAX_ATTACHMENT_RETENTION_HOURS = 8_760;
export const DEFAULT_ATTACHMENT_RETENTION_HOURS = 48;
export const AttachmentRetentionHours = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_ATTACHMENT_RETENTION_HOURS,
    maximum: MAX_ATTACHMENT_RETENTION_HOURS,
  }),
);
export type AttachmentRetentionHours = typeof AttachmentRetentionHours.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("cursor-agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

/**
 * Configuration for a user-owned external provider bridge speaking the
 * `solla.provider-bridge/1` application contract over MCP stdio.
 *
 * Arguments deliberately remain a newline-delimited string at the settings
 * boundary. The server turns each non-empty line into exactly one argv entry;
 * it never invokes a shell or tokenizes the line further.
 */
export const McpBridgeSettings = makeProviderSettingsSchema(
  {
    command: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Command",
        description:
          "Required absolute path to an external MCP provider bridge executable or script.",
        providerSettingsForm: {
          placeholder: "/absolute/path/to/provider-bridge",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    arguments: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Arguments",
        description:
          "Optional arguments, one literal argument per line. Lines are not shell-parsed.",
        providerSettingsForm: {
          control: "textarea",
          placeholder: "--profile\nwork",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    workingDirectory: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Working directory",
        description: "Optional absolute working directory for the external bridge process.",
        providerSettingsForm: {
          placeholder: "/absolute/path/to/project",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["command", "arguments", "workingDirectory"],
  },
);
export type McpBridgeSettings = typeof McpBridgeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

// ── Orchestrator (voice + text master agent) ─────────────────
//
// The orchestrator is a single always-available agent that spans every thread
// in the workspace. It is driven either by speech (OpenAI Realtime or Grok
// Voice via xAI) or by text typed into its dedicated thread, and both share
// one transcript.
//
// These live in `ServerSettings` rather than `ClientSettings` for two reasons:
// the API key must never be persisted client-side, and the orchestrator's
// behaviour (which events it announces, how much authority it has) must be
// identical from every client that connects to this environment.

export const OrchestratorActivationMode = Schema.Literals(["toggle", "wake-word"]);
export type OrchestratorActivationMode = typeof OrchestratorActivationMode.Type;
export const DEFAULT_ORCHESTRATOR_ACTIVATION_MODE: OrchestratorActivationMode = "toggle";

/**
 * How much the orchestrator is allowed to do without leaving the user's chair.
 * `read-only` can answer questions; `send` adds writing messages into threads;
 * `full` adds interrupting turns, stopping tasks, answering approvals and
 * settling threads.
 */
export const OrchestratorAuthority = Schema.Literals(["read-only", "send", "full"]);
export type OrchestratorAuthority = typeof OrchestratorAuthority.Type;
export const DEFAULT_ORCHESTRATOR_AUTHORITY: OrchestratorAuthority = "full";

export const DEFAULT_ORCHESTRATOR_REALTIME_MODEL = "gpt-realtime";
export const DEFAULT_ORCHESTRATOR_VOICE = "marin";
export const DEFAULT_ORCHESTRATOR_WAKE_WORD = "hey solla";
// ISO-639-1. Pinned in both the spoken instructions and the input-audio
// transcription config: with no pin the realtime model free-picks a language
// from ambiguous audio and has answered users in French unprompted.
export const DEFAULT_ORCHESTRATOR_LANGUAGE = "en";

/**
 * Per-event proactivity. Each flag gates one class of unprompted speech, so a
 * user who only wants to hear about blocked work can silence the rest.
 */
export const OrchestratorSpokenEvents = Schema.Struct({
  threadFinished: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  taskCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  approvalNeeded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  inputNeeded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  threadFailed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoResumeStuck: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type OrchestratorSpokenEvents = typeof OrchestratorSpokenEvents.Type;

/** Seconds of complete silence before the voice session closes itself. */
export const DEFAULT_ORCHESTRATOR_SILENCE_TIMEOUT_SECONDS = 30;

export const OrchestratorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Backward-compatible presence flag for the currently selected provider.
  // New clients render the two provider-specific flags below so switching
  // voice backends never replaces or clears the other backend's credential.
  apiKeyConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  openAiApiKeyConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  xaiApiKeyConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Which realtime backend mints the voice session. Defaults to OpenAI so
  // existing settings files keep working. `xai` is Grok Voice.
  provider: OrchestratorVoiceProvider.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_VOICE_PROVIDER)),
  ),
  model: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_REALTIME_MODEL)),
  ),
  voice: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_VOICE))),
  language: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_LANGUAGE)),
  ),
  activation: OrchestratorActivationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_ACTIVATION_MODE)),
  ),
  wakeWord: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_WAKE_WORD)),
  ),
  authority: OrchestratorAuthority.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_AUTHORITY)),
  ),
  // Speech recognition mishears. Under `full` authority a misheard "stop the
  // rover thread" would kill real work, so destructive tool calls re-ask by
  // default before executing.
  confirmDestructiveActions: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // The desktop's floating voice orb. Lives here rather than in client settings
  // so the same switch governs every client of this environment, like the rest
  // of the orchestrator's behaviour.
  floatingBubble: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // A realtime session bills for streamed silence, and an open microphone left
  // running after a conversation ends is both a cost and a privacy surprise.
  // On by default for that reason.
  autoDisableOnSilence: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  silenceTimeoutSeconds: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(600)),
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ORCHESTRATOR_SILENCE_TIMEOUT_SECONDS)),
  ),
  // Reopens the microphone when work the orchestrator said it would report back
  // on actually finishes. Without it, "I'll tell you when it's done" silently
  // became "you will never hear about this again" the moment the silence
  // timeout closed the session — the user is left waiting on a promise nothing
  // was ever going to keep. Only ever fires for work the orchestrator itself
  // was waiting on, and only after the *timeout* closed the session: a session
  // the user stopped by hand stays stopped.
  wakeOnAwaitedResult: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Whether talking over the orchestrator cuts it off. On by default, because
  // being unable to interrupt a long wrong answer is worse than the occasional
  // false trigger.
  //
  // Turning it off does two things: it stops barge-in, and it *closes the
  // microphone while the assistant speaks*. That second part is the only
  // reliable cure for the assistant hearing its own voice through a speaker and
  // answering itself — browser echo cancellation is requested and still loses on
  // a phone, and every client-side filter can only judge the echo after it has
  // already been uploaded and turned into a user turn by the server.
  interruptWhileSpeaking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Runs the microphone through a noise gate before it is sent.
   *
   * Off by default and rolled out deliberately: it sits in the outgoing audio
   * path, so a fault costs the user their voice rather than degrading it. The
   * platform's own `voiceIsolation` constraint is separate and always asked
   * for — this is the in-process stage on top of it.
   */
  voiceIsolation: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  spokenEvents: OrchestratorSpokenEvents,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type OrchestratorSettings = typeof OrchestratorSettings.Type;

export const ServerSettings = Schema.Struct({
  attachmentRetentionHours: AttachmentRetentionHours.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ATTACHMENT_RETENTION_HOURS)),
  ),
  autoCompactionThresholdPercentage: AutoCompactionThresholdPercentage.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENTAGE)),
  ),
  claudeTokenOptimizerEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  orchestrator: OrchestratorSettings,
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OrchestratorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  // Legacy write-only field. Older clients save it into whichever provider is
  // selected by the same patch/current settings. New clients use the two
  // explicit fields below. None of these are ever read back out.
  apiKey: Schema.optionalKey(TrimmedString),
  openAiApiKey: Schema.optionalKey(TrimmedString),
  xaiApiKey: Schema.optionalKey(TrimmedString),
  provider: Schema.optionalKey(OrchestratorVoiceProvider),
  model: Schema.optionalKey(TrimmedString),
  voice: Schema.optionalKey(TrimmedString),
  language: Schema.optionalKey(TrimmedString),
  activation: Schema.optionalKey(OrchestratorActivationMode),
  wakeWord: Schema.optionalKey(TrimmedString),
  authority: Schema.optionalKey(OrchestratorAuthority),
  confirmDestructiveActions: Schema.optionalKey(Schema.Boolean),
  floatingBubble: Schema.optionalKey(Schema.Boolean),
  autoDisableOnSilence: Schema.optionalKey(Schema.Boolean),
  silenceTimeoutSeconds: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(600)),
    ),
  ),
  wakeOnAwaitedResult: Schema.optionalKey(Schema.Boolean),
  interruptWhileSpeaking: Schema.optionalKey(Schema.Boolean),
  voiceIsolation: Schema.optionalKey(Schema.Boolean),
  spokenEvents: Schema.optionalKey(
    Schema.Struct({
      threadFinished: Schema.optionalKey(Schema.Boolean),
      taskCompleted: Schema.optionalKey(Schema.Boolean),
      approvalNeeded: Schema.optionalKey(Schema.Boolean),
      inputNeeded: Schema.optionalKey(Schema.Boolean),
      threadFailed: Schema.optionalKey(Schema.Boolean),
      autoResumeStuck: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type OrchestratorSettingsPatch = typeof OrchestratorSettingsPatch.Type;

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  attachmentRetentionHours: Schema.optionalKey(AttachmentRetentionHours),
  autoCompactionThresholdPercentage: Schema.optionalKey(AutoCompactionThresholdPercentage),
  claudeTokenOptimizerEnabled: Schema.optionalKey(Schema.Boolean),
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  orchestrator: Schema.optionalKey(OrchestratorSettingsPatch),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  agentStackEnabled: Schema.optionalKey(Schema.Boolean),
  agentDesktopNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  autoSendVoiceTranscription: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  pushToTalkMutesSystemAudio: Schema.optionalKey(Schema.Boolean),
  voiceTranscriptionCorrectionEnabled: Schema.optionalKey(Schema.Boolean),
  // This client setting is replaced atomically, not deep-merged. Requiring the
  // complete selection keeps persisted client state from losing its provider
  // or model when a patch is spread into the current settings object.
  voiceTranscriptionCorrectionModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  sidebarV2Enabled: Schema.optionalKey(Schema.Boolean),
  sidebarV2ConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  showResumeThreadsOnStartup: Schema.optionalKey(Schema.Boolean),
  soundCues: Schema.optionalKey(Schema.Boolean),
  soundCueVolume: Schema.optionalKey(SoundCueVolume),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
