import { selectedUsageGuardEffort } from "../ProviderUsageGuard.ts";
import {
  CommandId,
  DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS,
  EventId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageGuardState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { isUsageGuardYield } from "../usageGuardYield.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { providerDisplayLabel } from "@t3tools/shared/model";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ThreadWorkObligation,
  ThreadWorkObligationRepository,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  applyUsageGuardOptimization,
  emptyUsageGuardInstanceState,
  emptyUsageGuardWindowState,
  evaluateUsageGuard,
  measuredEffortCost,
  findEffortDescriptor,
  extractUsageWindows,
  FALLBACK_TOKENS_PER_PERCENT,
  providerModelOptionDescriptors,
  recordTokensIntoState,
  recordWindowsIntoState,
  recordUsageGuardCredits,
  resolveUsageGuardEvaluationModel,
  resolveUsageGuardProviderConfig,
  toServerProviderUsageGuardState,
  usageGuardStatesEqual,
  USAGE_GUARD_PAUSED_REASON,
  USAGE_GUARD_RESUMED_ACTIVITY_KIND,
  usageGuardWakeAtMs,
  type UsageGuardInstanceState,
  recordBackgroundAdmission,
} from "../ProviderUsageGuard.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderUsageGuard,
  type ProviderUsageGuardShape,
  type UsageGuardDecision,
} from "../Services/ProviderUsageGuard.ts";
import { ThreadWorkScheduler } from "../Services/ThreadWorkScheduler.ts";

/**
 * Measured per-effort turn costs and today's credit spend survive restarts in
 * a small JSON file next to the state database. Reported percentages are live
 * data that the next provider report replaces within seconds. The
 * `instances` key once held learned tokens-per-percent ratios; ratio learning
 * was removed 2026-09-06 and the key is kept empty for file compatibility.
 */
const CalibrationFile = Schema.Struct({
  version: Schema.Literal(1),
  dailyCredits: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ startsAt: Schema.Number, spent: Schema.Number })),
  ),
  effortCosts: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Record(
        Schema.String,
        Schema.Struct({
          ewmaWeightedTokens: Schema.Number,
          samples: Schema.Number,
          credits: Schema.NullOr(Schema.Number),
        }),
      ),
    ),
  ),
  instances: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({
        learnedTokensPerPercent: Schema.NullOr(Schema.Number),
        calibrationSamples: Schema.Number,
      }),
    ),
  ),
});

const CALIBRATION_FLUSH_INTERVAL = Duration.seconds(60);
const CALIBRATION_FILE_NAME = "usage-guard-calibration.json";
const MAX_THREAD_OVERRIDES = 512;
const OVERRIDE_FALLBACK_TTL_MS = 60 * 60_000;
/** Refresh a hold's reading when the newest report is older than this. */
const REFRESH_MAX_AGE_MS = 60_000;
/** A person pressing Resume gets a reading no older than this. */
const RESUME_REFRESH_MAX_AGE_MS = 20_000;
const REFRESH_TIMEOUT = "12 seconds";

/** Epoch ms of the newest provider report folded into `state`; null before any. */
export function latestUsageReportAtMs(state: UsageGuardInstanceState): number | null {
  let latest: number | null = null;
  for (const window of Object.values(state.windows)) {
    if (latest === null || window.reportedAtMs > latest) latest = window.reportedAtMs;
  }
  return latest;
}
const HELD_PAGE_SIZE = 200;
/** Reports can arrive every call; held work is re-checked at most this often per instance. */
const RECONSIDER_MIN_INTERVAL_MS = 20_000;
/** Held work is also re-checked on a timer, so a thread going idle is noticed within a minute. */
const RECONSIDER_TICK = Duration.seconds(60);

const decodeCalibration = Schema.decodeUnknownEffect(Schema.fromJsonString(CalibrationFile));
const encodeCalibration = Schema.encodeEffect(Schema.fromJsonString(CalibrationFile));

interface HeldRow {
  readonly obligationId: string;
  readonly attempt: number;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly updatedAt: string;
  readonly blockedReason: string | null;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const obligations = yield* ThreadWorkObligationRepository;
  const scheduler = yield* ThreadWorkScheduler;
  const engine = yield* OrchestrationEngineService;

  const admissionLock = yield* Semaphore.make(1);
  const calibrationPath = path.join(config.stateDir, CALIBRATION_FILE_NAME);
  const states = yield* Ref.make<ReadonlyMap<string, UsageGuardInstanceState>>(new Map());
  /** Thread id → epoch ms until which a user resume keeps its work flowing. */
  const overrides = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const calibrationDirty = yield* Ref.make(false);
  /** Instance id → the `accountUsageReportedAt` already folded from a registry snapshot. */
  const seenSnapshotReports = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  /** Last reading actually published per instance, so an unchanged one is not re-broadcast. */
  const publishedStates = yield* Ref.make<ReadonlyMap<string, ServerProviderUsageGuardState>>(
    new Map(),
  );
  const lastReconsiderAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const loadCalibration = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(calibrationPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return;
    const parsed = yield* decodeCalibration(raw).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage-guard.calibration.unreadable", {
          path: calibrationPath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (parsed === null) return;
    yield* Ref.update(states, (current) => {
      const next = new Map(current);
      // Learned tokens-per-percent survives restarts on purpose: a window has
      // to climb 5 points before it teaches anything, so re-learning from
      // scratch every launch would leave the guard running on the default
      // guess — the one that priced a turn at 380x its real cost — for the
      // whole of every session's first stretch of work.
      for (const [instanceId, windows] of Object.entries(parsed.instances ?? {})) {
        const existing = next.get(instanceId) ?? emptyUsageGuardInstanceState("unknown");
        next.set(instanceId, {
          ...existing,
          windows: Object.fromEntries(
            Object.entries(windows).map(([key, learned]) => [
              key,
              {
                ...(existing.windows[key] ?? emptyUsageGuardWindowState(key)),
                learnedTokensPerPercent: learned.learnedTokensPerPercent,
                calibrationSamples: learned.calibrationSamples,
              },
            ]),
          ),
        });
      }
      for (const [instanceId, costByEffort] of Object.entries(parsed.effortCosts ?? {})) {
        next.set(instanceId, {
          ...(next.get(instanceId) ?? emptyUsageGuardInstanceState("unknown")),
          costByEffort,
        });
      }
      for (const [instanceId, dailyCredits] of Object.entries(parsed.dailyCredits ?? {})) {
        next.set(instanceId, {
          ...(next.get(instanceId) ?? emptyUsageGuardInstanceState("unknown")),
          dailyCredits,
        });
      }
      return next;
    });
    yield* Ref.set(calibrationDirty, true);
  });

  const flushCalibration = Effect.gen(function* () {
    const dirty = yield* Ref.getAndSet(calibrationDirty, false);
    if (!dirty) return;
    const current = yield* Ref.get(states);
    const contents = yield* encodeCalibration({
      version: 1,
      instances: Object.fromEntries(
        [...current].map(([id, state]) => [
          id,
          Object.fromEntries(
            Object.entries(state.windows).flatMap(([key, window]) =>
              window.learnedTokensPerPercent === null
                ? []
                : [
                    [
                      key,
                      {
                        learnedTokensPerPercent: window.learnedTokensPerPercent,
                        calibrationSamples: window.calibrationSamples,
                      },
                    ],
                  ],
            ),
          ),
        ]),
      ),
      dailyCredits: Object.fromEntries(
        [...current].flatMap(([id, state]) =>
          state.dailyCredits ? [[id, state.dailyCredits]] : [],
        ),
      ),
      effortCosts: Object.fromEntries(
        [...current].map(([id, state]) => [id, state.costByEffort ?? {}]),
      ),
    });
    yield* writeFileStringAtomically({ filePath: calibrationPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage-guard.calibration.flush-failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const providerFor = (instanceId: ProviderInstanceId) =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => providers.find((candidate) => candidate.instanceId === instanceId)),
    );

  const providerLabel = (provider: ServerProvider | undefined, instanceId: ProviderInstanceId) =>
    provider === undefined
      ? String(instanceId)
      : providerDisplayLabel(provider.displayName, provider.driver);

  const activeThreadsFor = (instanceId: ProviderInstanceId) =>
    scheduler.snapshot.pipe(
      Effect.map((snapshot) => snapshot.activeByProvider[String(instanceId)] ?? 0),
      Effect.orElseSucceed(() => 0),
    );

  const settingsOrNull = settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));

  /** One evaluation of the instance for a turn on `model`, with the live thread count. */
  const readInstance = Effect.fn("ProviderUsageGuard.readInstance")(function* (
    instanceId: ProviderInstanceId,
    model: string | null,
    fast?: boolean,
    effort?: string,
  ) {
    const settings = yield* settingsOrNull;
    const provider = yield* providerFor(instanceId);
    const state =
      (yield* Ref.get(states)).get(String(instanceId)) ??
      emptyUsageGuardInstanceState(String(provider?.driver ?? "unknown"));
    const at = yield* nowMs;
    const guardConfig = resolveUsageGuardProviderConfig(
      settings ?? { usageGuard: { enabled: false, providers: {} } },
      instanceId,
    );
    const activeThreads = yield* activeThreadsFor(instanceId);
    const evaluation = evaluateUsageGuard({
      state,
      config: guardConfig,
      nowMs: at,
      model: resolveUsageGuardEvaluationModel({
        requested: model,
        lastUsed: state.calls.at(-1)?.model ?? null,
        models: provider?.models ?? [],
      }),
      fast: fast ?? state.calls.at(-1)?.fast ?? false,
      activeThreads,
      effort,
    });
    return {
      state,
      activeThreads,
      evaluation,
      config: guardConfig,
      provider,
      at,
      label: providerLabel(provider, instanceId),
    };
  });

  /**
   * Publish the instance's guard reading onto its provider snapshot.
   *
   * Only when it says something new. Writing the snapshot broadcasts the whole
   * provider list to every client, and `updatedAt` moves on every publish — so
   * republishing an unchanged reading is pure render churn on the clients. The
   * timestamp is deliberately excluded from the comparison and then carried
   * forward from the published state, so it means "as of when this reading was
   * true" rather than "when it was last recomputed".
   */
  const publishState = Effect.fn("ProviderUsageGuard.publishState")(function* (
    instanceId: ProviderInstanceId,
  ) {
    if (!(yield* Ref.get(states)).has(String(instanceId))) return;
    const { evaluation, config: guardConfig } = yield* readInstance(instanceId, null);
    const key = String(instanceId);
    const previous = (yield* Ref.get(publishedStates)).get(key);
    const next = toServerProviderUsageGuardState({
      evaluation,
      config: guardConfig,
      nowIso: previous?.updatedAt ?? (yield* nowIso),
    });
    if (previous !== undefined && usageGuardStatesEqual(previous, next)) return;
    const published = previous === undefined ? next : { ...next, updatedAt: yield* nowIso };
    yield* Ref.update(publishedStates, (current) => {
      const map = new Map(current);
      map.set(key, published);
      return map;
    });
    yield* providerRegistry
      .setProviderUsageGuardState({ instanceId, state: published })
      .pipe(Effect.ignore);
  });

  const overrideActive = Effect.fn("ProviderUsageGuard.overrideActive")(function* (
    threadId: ThreadId | undefined,
  ) {
    if (threadId === undefined) return false;
    const until = (yield* Ref.get(overrides)).get(String(threadId));
    if (until === undefined) return false;
    const at = yield* nowMs;
    if (until > at) return true;
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      next.delete(String(threadId));
      return next;
    });
    return false;
  });

  /**
   * Anchor the pace cooldown: background work went out now, so the next
   * piece waits its spacing from here. Only meaningful while the guard is
   * metering, but cheap and harmless otherwise.
   */
  const markBackgroundAdmitted = Effect.fn("ProviderUsageGuard.markBackgroundAdmitted")(function* (
    instanceId: ProviderInstanceId,
    at: number,
  ) {
    yield* Ref.update(states, (current) => {
      const previous = current.get(String(instanceId));
      if (previous === undefined) return current;
      const next = new Map(current);
      next.set(String(instanceId), recordBackgroundAdmission(previous, at));
      return next;
    });
    yield* Ref.set(calibrationDirty, true);
  });

  /** Every obligation the guard is holding on this instance, oldest first. */
  const collectHeldRows = Effect.fn("ProviderUsageGuard.collectHeldRows")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const held: HeldRow[] = [];
    let afterUpdatedAt: string | null = null;
    let afterObligationId: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows: ReadonlyArray<ThreadWorkObligation> = yield* obligations
        .listByState({
          providerInstanceId: instanceId,
          state: "sleeping",
          afterUpdatedAt,
          afterObligationId,
          limit: HELD_PAGE_SIZE,
        })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<ThreadWorkObligation> => []));
      for (const row of rows) {
        if (
          row.blockedReason === USAGE_GUARD_PAUSED_REASON ||
          isUsageGuardYield(row.blockedReason)
        ) {
          held.push({
            obligationId: row.obligationId,
            attempt: row.attempt,
            threadId: row.threadId,
            providerInstanceId: row.providerInstanceId,
            updatedAt: row.updatedAt,
            blockedReason: row.blockedReason,
          });
        }
      }
      if (rows.length < HELD_PAGE_SIZE) break;
      const last: ThreadWorkObligation | undefined = rows[rows.length - 1];
      if (last === undefined) break;
      afterUpdatedAt = last.updatedAt;
      afterObligationId = last.obligationId;
    }
    held.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    return held;
  });

  const releaseRows = Effect.fn("ProviderUsageGuard.releaseRows")(function* (
    rows: ReadonlyArray<HeldRow>,
  ) {
    const updatedAt = yield* nowIso;
    let released = 0;
    for (const row of rows) {
      const transitioned = yield* obligations
        .transition({
          obligationId: row.obligationId,
          expectedState: "sleeping",
          expectedAttempt: row.attempt,
          state: "pending",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: row.blockedReason,
          updatedAt,
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (transitioned) released += 1;
    }
    return released;
  });

  const reconsiderHeldWork: ProviderUsageGuardShape["reconsiderHeldWork"] = Effect.fn(
    "ProviderUsageGuard.reconsiderHeldWork",
  )(function* (input) {
    const held = yield* collectHeldRows(input.instanceId);
    if (held.length === 0) return { released: 0 };
    const { evaluation, config: guardConfig } = yield* readInstance(input.instanceId, null);
    // Threads the user resumed by hand always go, and count against nothing.
    const overriddenRows: HeldRow[] = [];
    const candidates: HeldRow[] = [];
    const seenThreads = new Set<string>();
    for (const row of held) {
      if (yield* overrideActive(row.threadId)) {
        overriddenRows.push(row);
        continue;
      }
      // One obligation per thread: releasing two for the same thread just
      // makes the second wait on the first at the scheduler.
      if (seenThreads.has(String(row.threadId))) continue;
      seenThreads.add(String(row.threadId));
      candidates.push(row);
    }
    const room =
      !guardConfig.active || !guardConfig.holdBackgroundWork
        ? candidates.length
        : evaluation.admitBackground && evaluation.tier !== "pause"
          ? 1
          : 0;
    // Waking a row is not admission. The serialized dispatch gate reserves
    // budget only when the worker actually runs.
    const toRelease = [...overriddenRows, ...candidates.slice(0, room)];
    if (toRelease.length === 0) return { released: 0 };
    const released = yield* releaseRows(toRelease);
    if (released > 0) {
      yield* scheduler.wake(input.instanceId);
      yield* Effect.logInfo("usage-guard.released", {
        instanceId: input.instanceId,
        released,
        stillHeld: held.length - released,
        tier: evaluation.tier,
        backgroundBudget: evaluation.backgroundBudget,
        activeThreads: evaluation.activeThreads,
        backgroundCooldownMs: evaluation.backgroundCooldownMs,
      });
    }
    return { released };
  });

  const reconsiderThrottled = Effect.fn("ProviderUsageGuard.reconsiderThrottled")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const at = yield* nowMs;
    const last = (yield* Ref.get(lastReconsiderAt)).get(String(instanceId)) ?? 0;
    if (at - last < RECONSIDER_MIN_INTERVAL_MS) return;
    yield* Ref.update(lastReconsiderAt, (current) => {
      const next = new Map(current);
      next.set(String(instanceId), at);
      return next;
    });
    yield* reconsiderHeldWork({ instanceId }).pipe(Effect.ignore);
  });

  const recordRateLimits: ProviderUsageGuardShape["recordRateLimits"] = Effect.fn(
    "ProviderUsageGuard.recordRateLimits",
  )(function* (input) {
    const windows = extractUsageWindows(String(input.driver), input.rateLimits);
    if (windows.length === 0 && String(input.driver) !== "codex") return;
    const at = yield* nowMs;
    const key = String(input.instanceId);
    let changedCalibration = false;
    yield* Ref.update(states, (current) => {
      const next = new Map(current);
      const previous = next.get(key) ?? emptyUsageGuardInstanceState(String(input.driver));
      const base =
        previous.driver === String(input.driver)
          ? previous
          : { ...previous, driver: String(input.driver) };
      const updated = recordUsageGuardCredits(
        recordWindowsIntoState(base, windows, at),
        input.rateLimits,
      );
      for (const window of Object.values(updated.windows)) {
        const before = base.windows[window.key];
        if (before?.calibrationSamples !== window.calibrationSamples) changedCalibration = true;
      }
      next.set(key, updated);
      return next;
    });
    if (changedCalibration) yield* Ref.set(calibrationDirty, true);
    yield* publishState(input.instanceId);
    yield* reconsiderThrottled(input.instanceId);
  });

  const recordTokens: ProviderUsageGuardShape["recordTokens"] = Effect.fn(
    "ProviderUsageGuard.recordTokens",
  )(function* (input) {
    if (!Number.isFinite(input.tokens) || input.tokens <= 0) return;
    const at = yield* nowMs;
    const key = String(input.instanceId);
    const activeThreads = yield* activeThreadsFor(input.instanceId);
    yield* Ref.update(states, (current) => {
      const previous = current.get(key);
      const driver =
        input.driver === undefined ? (previous?.driver ?? "unknown") : String(input.driver);
      const base = previous ?? emptyUsageGuardInstanceState(driver);
      const next = new Map(current);
      next.set(
        key,
        recordTokensIntoState(base, {
          tokens: input.tokens,
          model: input.model ?? null,
          nowMs: at,
          activeThreads,
          usage: input.usage,
          threadKey: input.threadKey,
          fast: input.fast,
          effort: input.effort,
        }),
      );
      return next;
    });
    yield* Ref.set(calibrationDirty, true);
    yield* flushCalibration;
  });

  const decide = Effect.fn("ProviderUsageGuard.decide")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId?: ThreadId | undefined;
    readonly purpose: "user-turn" | "background" | "running";
    readonly fast?: boolean | undefined;
    readonly effort?: string | undefined;
    readonly model?: string | null | undefined;
  }) {
    const {
      evaluation,
      config: guardConfig,
      at,
      label,
      state,
      activeThreads,
      provider,
    } = yield* readInstance(input.instanceId, input.model ?? null, input.fast, input.effort);
    const wakeAtIso = DateTime.formatIso(DateTime.makeUnsafe(usageGuardWakeAtMs(evaluation, at)));
    const overridden = yield* overrideActive(input.threadId);
    const models = provider?.models ?? [];
    const candidates = [
      models.find((model) => model.slug === evaluation.model),
      ...models.filter((model) => model.slug !== evaluation.model),
    ].filter((model) => model !== undefined);
    const effortEstimates = candidates.flatMap((model) => {
      const descriptor = findEffortDescriptor(model.capabilities?.optionDescriptors);
      const choices = descriptor?.options.length
        ? descriptor.options
        : [{ id: "default", label: "Default" }];
      return choices.map((option) => {
        const fast = model.slug === evaluation.model ? (input.fast ?? false) : false;
        const sample = measuredEffortCost(state, model.slug, option.id, fast);
        const candidate = evaluateUsageGuard({
          state,
          config: guardConfig,
          nowMs: at,
          model: model.slug,
          activeThreads,
          fast,
          effort: option.id,
        });
        return {
          effort: option.id,
          ...(descriptor ? { optionId: descriptor.id } : {}),
          model: model.slug,
          samples: sample?.samples ?? 0,
          windowLabel: candidate.windowLabel,
          resumeAt:
            // Releasing the hold on work already asked for is one thing;
            // advertising a model whose own window is spent as "Ready now" is
            // another. Fable at 100% was being recommended over the model in
            // use, and picking it would have failed at the provider. A quote is
            // a recommendation, so it answers to the quota even where the hold
            // no longer does.
            candidate.tier === "pause" || (candidate.reportedPercent ?? 0) >= 100
              ? null
              : candidate.admitBackground
                ? at
                : usageGuardWakeAtMs(candidate, at),
        };
      });
    });
    const reportedAtMs = latestUsageReportAtMs(state);
    const base = {
      evaluation,
      config: guardConfig,
      wakeAtIso,
      overridden,
      providerLabel: label,
      reportedAt:
        reportedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(reportedAtMs)),
      effortEstimates,
    };
    if (!guardConfig.active || evaluation.tier === "none") {
      if (guardConfig.active && input.purpose === "background" && !overridden) {
        yield* markBackgroundAdmitted(input.instanceId, at);
      }
      return { ...base, action: "allow" } satisfies UsageGuardDecision;
    }
    // A pause withholds work nobody is waiting on. A message the person typed
    // is the opposite, and holding it points the quota reserve at the very
    // person it is reserved for: the hold cannot lift while usage stays high,
    // so the message waits indefinitely. Observed 2026-09-07 — two threads
    // with the user's own messages parked behind "weekly is at ~94%, which
    // leaves ~3.0% before the 3% reserve", re-checking every 5 minutes with no
    // end. Their turn goes out at reduced effort; if the account really is
    // spent, the provider's own error is the honest place to say so.
    if (evaluation.tier === "pause" && input.purpose !== "user-turn") {
      return { ...base, action: overridden ? "optimize" : "pause" } satisfies UsageGuardDecision;
    }
    if (input.purpose !== "user-turn" && !evaluation.admitBackground && !overridden) {
      return { ...base, action: "pause" } satisfies UsageGuardDecision;
    }
    if (input.purpose === "background" && !overridden) {
      yield* markBackgroundAdmitted(input.instanceId, at);
    }
    return { ...base, action: "optimize" } satisfies UsageGuardDecision;
  });

  const evaluate: ProviderUsageGuardShape["evaluate"] = (input) =>
    admissionLock.withPermit(decide(input));

  const optimizeModelSelection: ProviderUsageGuardShape["optimizeModelSelection"] = Effect.fn(
    "ProviderUsageGuard.optimizeModelSelection",
  )(function* (input) {
    const decision = yield* decide({
      instanceId: input.instanceId,
      purpose: "user-turn",
      model: input.modelSelection.model,
      effort: selectedUsageGuardEffort(input.modelSelection),
      fast:
        input.modelSelection.options?.some(
          (option) => option.id === "serviceTier" && option.value === "priority",
        ) ?? false,
    });
    const target = decision.evaluation.effortTarget;
    if (decision.action === "allow" || target === null) {
      return { modelSelection: input.modelSelection, applied: null, decision };
    }
    const provider = yield* providerFor(input.instanceId);
    const result = applyUsageGuardOptimization({
      modelSelection: input.modelSelection,
      descriptors: providerModelOptionDescriptors(provider, input.modelSelection.model),
      targetEffort: target,
    });
    return { ...result, decision };
  });

  const resumeThread: ProviderUsageGuardShape["resumeThread"] = Effect.fn(
    "ProviderUsageGuard.resumeThread",
  )(function* (input) {
    const at = yield* nowMs;
    if (input.modelSelection) {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`usage-effort-meta:${uuid}`),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.orDie);
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`usage-effort:${uuid}`),
          threadId: input.threadId,
          activity: {
            id: EventId.make(`usage-effort:${uuid}`),
            kind: "usage-guard.effort-selected",
            tone: "info",
            summary: "Thinking effort updated for queued work",
            payload: { modelSelection: input.modelSelection },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.orDie);
    }
    const providers = yield* providerRegistry.getProviders;
    const held: HeldRow[] = [];
    for (const provider of providers) {
      for (const row of yield* collectHeldRows(provider.instanceId)) {
        if (row.threadId === input.threadId) held.push(row);
      }
    }
    const instanceId = held[0]?.providerInstanceId;
    // A person acting on the hold deserves a current reading: the summary they
    // just read may be hours old, and the turn they release runs against the
    // account as it is now.
    if (instanceId !== undefined) {
      yield* refreshUsage({ instanceId, maxAgeMs: RESUME_REFRESH_MAX_AGE_MS }).pipe(Effect.ignore);
    }
    const instance = instanceId === undefined ? null : yield* readInstance(instanceId, null);
    const resetsAtMs = instance?.evaluation.resetsAtMs ?? null;
    // Resume is never refused. An account at 100% with no credits used to be
    // told no here, on the reasoning that the turn would fail at the provider
    // anyway — but a guard that silently withholds work is worse than the
    // provider's own error, which says plainly what is wrong and can be acted
    // on. The same rule decides the hold itself, so the two agree.
    const until =
      resetsAtMs !== null && resetsAtMs > at ? resetsAtMs : at + OVERRIDE_FALLBACK_TTL_MS;
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      if (input.recheckOnly) next.delete(String(input.threadId));
      else next.set(String(input.threadId), until);
      if (next.size > MAX_THREAD_OVERRIDES) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
    const released = yield* releaseRows(held);
    if (instanceId !== undefined) yield* scheduler.wake(instanceId);
    if (input.recheckOnly) return { resumed: released > 0 };
    const overrideUntilIso = DateTime.formatIso(DateTime.makeUnsafe(until));
    yield* Effect.logInfo("usage-guard.resumed", {
      threadId: input.threadId,
      heldRows: held.length,
      released,
      overrideUntil: overrideUntilIso,
    });
    const provider = instanceId === undefined ? undefined : yield* providerFor(instanceId);
    const label = instanceId === undefined ? "the provider" : providerLabel(provider, instanceId);
    const eventId = yield* crypto.randomUUIDv4.pipe(Effect.map(EventId.make), Effect.orDie);
    const commandId = yield* crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:usage-guard-resumed:${uuid}`)),
      Effect.orDie,
    );
    const createdAt = yield* nowIso;
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: eventId,
          tone: "info",
          kind: USAGE_GUARD_RESUMED_ACTIVITY_KIND,
          summary: `Resumed by the user · usage guard override for ${label} until the window resets`,
          payload: {
            instanceId: instanceId ?? null,
            overrideUntil: overrideUntilIso,
            resumedObligations: released,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage-guard.resumed.activity-failed", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    return { resumed: released > 0 };
  });

  /**
   * Health probes report usage too (`ServerProvider.accountUsage`), and for a
   * provider with no live turn they are the only reports there are. Fold
   * every snapshot whose report time the guard has not seen yet.
   */
  const foldProviderSnapshots = Effect.fn("ProviderUsageGuard.foldProviderSnapshots")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    for (const provider of providers) {
      if (provider.accountUsage === undefined || provider.accountUsageReportedAt === undefined) {
        continue;
      }
      const key = String(provider.instanceId);
      const seen = (yield* Ref.get(seenSnapshotReports)).get(key);
      if (seen === provider.accountUsageReportedAt) continue;
      yield* Ref.update(seenSnapshotReports, (current) => {
        const next = new Map(current);
        next.set(key, provider.accountUsageReportedAt!);
        return next;
      });
      yield* recordRateLimits({
        instanceId: provider.instanceId,
        driver: provider.driver,
        rateLimits: provider.accountUsage,
        reportedAt: provider.accountUsageReportedAt,
      });
    }
  });

  const refreshInFlight = new Map<string, Deferred.Deferred<void>>();
  const refreshUsage: ProviderUsageGuardShape["refreshUsage"] = Effect.fn(
    "ProviderUsageGuard.refreshUsage",
  )(function* (input) {
    const key = String(input.instanceId);
    const at = yield* nowMs;
    const reportedAtIso = (state: UsageGuardInstanceState | undefined) => {
      const ms = state === undefined ? null : latestUsageReportAtMs(state);
      return ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
    };
    const before = (yield* Ref.get(states)).get(key);
    const age =
      before === undefined ? Number.POSITIVE_INFINITY : at - (latestUsageReportAtMs(before) ?? 0);
    if (age <= (input.maxAgeMs ?? REFRESH_MAX_AGE_MS)) {
      return { refreshed: false, reportedAt: reportedAtIso(before) };
    }
    const pending = refreshInFlight.get(key);
    if (pending !== undefined) {
      // Another hold on the same instance is already probing; share its result.
      yield* Deferred.await(pending).pipe(Effect.timeout(REFRESH_TIMEOUT), Effect.ignore);
      return { refreshed: true, reportedAt: reportedAtIso((yield* Ref.get(states)).get(key)) };
    }
    const gate = yield* Deferred.make<void>();
    refreshInFlight.set(key, gate);
    yield* providerRegistry.refreshInstance(input.instanceId).pipe(
      Effect.timeout(REFRESH_TIMEOUT),
      Effect.flatMap((providers) => foldProviderSnapshots(providers)),
      Effect.catchCause((cause) =>
        Effect.logWarning("usage-guard.refresh-failed", {
          instanceId: key,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          refreshInFlight.delete(key);
        }).pipe(Effect.andThen(Deferred.succeed(gate, undefined))),
      ),
    );
    return { refreshed: true, reportedAt: reportedAtIso((yield* Ref.get(states)).get(key)) };
  });

  yield* loadCalibration.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("usage-guard.calibration.load-failed", { cause: Cause.pretty(cause) }),
    ),
  );
  yield* flushCalibration.pipe(
    Effect.repeat(Schedule.spaced(CALIBRATION_FLUSH_INTERVAL)),
    Effect.forkScoped,
  );
  yield* providerRegistry.subscribeChanges.pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.runForEach((providers) =>
          foldProviderSnapshots(providers).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("usage-guard.snapshot-fold-failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* providerRegistry.getProviders.pipe(
    Effect.flatMap(foldProviderSnapshots),
    Effect.catchCause((cause) =>
      Effect.logWarning("usage-guard.snapshot-seed-failed", { cause: Cause.pretty(cause) }),
    ),
  );
  // Revalidate persisted holds at startup. The dispatch gate still owns admission;
  // this also lets stopped continuations retire without waiting out an old cooldown.
  for (const provider of yield* providerRegistry.getProviders) {
    const released = yield* releaseRows(yield* collectHeldRows(provider.instanceId));
    if (released > 0) yield* scheduler.wake(provider.instanceId);
  }
  yield* Effect.gen(function* () {
    for (const key of (yield* Ref.get(states)).keys()) {
      yield* reconsiderHeldWork({ instanceId: key as ProviderInstanceId }).pipe(Effect.ignore);
    }
  }).pipe(Effect.repeat(Schedule.spaced(RECONSIDER_TICK)), Effect.forkScoped);

  return {
    recordRateLimits,
    recordTokens,
    evaluate,
    optimizeModelSelection,
    resumeThread,
    reconsiderHeldWork,
    refreshUsage,
  } satisfies ProviderUsageGuardShape;
});

export const ProviderUsageGuardLive = Layer.effect(ProviderUsageGuard, make);

/**
 * Inert guard for tests and harnesses that only need the service present:
 * records nothing, never optimizes, never holds. Keeps suites off the
 * calibration file and the provider registry.
 */
export const ProviderUsageGuardNoop = Layer.succeed(ProviderUsageGuard, {
  recordRateLimits: () => Effect.void,
  recordTokens: () => Effect.void,
  evaluate: (input) =>
    Effect.map(nowIsoNoop, (wakeAtIso) => inertDecision(input.instanceId, wakeAtIso)),
  optimizeModelSelection: (input) =>
    Effect.map(nowIsoNoop, (wakeAtIso) => ({
      modelSelection: input.modelSelection,
      applied: null,
      decision: inertDecision(input.instanceId, wakeAtIso),
    })),
  resumeThread: () => Effect.succeed({ resumed: false }),
  reconsiderHeldWork: () => Effect.succeed({ released: 0 }),
  refreshUsage: () => Effect.succeed({ refreshed: false, reportedAt: null }),
} satisfies ProviderUsageGuardShape);

const nowIsoNoop = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function inertDecision(instanceId: ProviderInstanceId, wakeAtIso: string): UsageGuardDecision {
  return {
    action: "allow",
    reportedAt: null,
    evaluation: {
      tier: "none",
      summary: "Off",
      windowKey: null,
      windowLabel: null,
      windowScope: null,
      reportedPercent: null,
      elapsedPercent: null,
      aheadOfPacePercent: null,
      estimatedPercent: null,
      resetsAtMs: null,
      burnPercentPerHour: null,
      projectedAtResetPercent: null,
      turnCostPercent: null,
      remainingPercent: null,
      headroomPercent: DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS.headroomPercent,
      pressure: 0,
      effortTarget: null,
      backgroundBudget: null,
      activeThreads: 0,
      admitBackground: true,
      backgroundCooldownMs: null,
      nextBackgroundAdmitAtMs: null,
      tokensPerPercent: FALLBACK_TOKENS_PER_PERCENT,
      percentPerMillionTokens: 1_000_000 / FALLBACK_TOKENS_PER_PERCENT,
      tokenCapSpent: null,
      tokensPerPercentSource: "default",
      learnedTokensPerPercent: null,
      tokensSinceReport: 0,
      model: null,
      windows: [],
    },
    config: { ...DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS, active: false },
    wakeAtIso,
    overridden: false,
    providerLabel: String(instanceId),
  };
}
