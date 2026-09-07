import {
  type OrchestrationCommand,
  type ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { ThreadWorkObligationRepository } from "../../persistence/Services/ThreadWorkObligations.ts";
import { ThreadWorkScheduler } from "../Services/ThreadWorkScheduler.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderUsageGuard } from "../Services/ProviderUsageGuard.ts";
import { ProviderUsageGuardLive } from "./ProviderUsageGuard.ts";

const makeLayer = (
  commands: OrchestrationCommand[] = [],
  providers: ServerProvider[] = [],
  baseDir?: string,
) =>
  ProviderUsageGuardLive.pipe(
    Layer.provide(makeProviderRegistryLayer(providers)),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), baseDir ?? { prefix: "usage-pacing-test-" }),
    ),
    Layer.provide(
      Layer.mock(ThreadWorkObligationRepository, { listByState: () => Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(ThreadWorkScheduler, {
        snapshot: Effect.succeed({
          activeGlobal: 3,
          activeByProvider: { claudeAgent: 3 },
          activeRecoveryByProvider: {},
          activeThreads: [],
          schedulerWindowSize: 10,
          runtimeByThread: {},
        }),
        wake: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService, {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const layer = makeLayer();

it.effect(
  "serializes concurrent agents against one clock and automatically releases them after reset",
  () =>
    Effect.gen(function* () {
      const guard = yield* ProviderUsageGuard;
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const now = yield* DateTime.now;
      yield* guard.recordRateLimits({
        instanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        reportedAt: DateTime.formatIso(now),
        rateLimits: {
          rate_limits: {
            five_hour: {
              utilization: 54,
              resets_at: DateTime.formatIso(DateTime.add(now, { minutes: 226 })),
            },
          },
        },
      });
      const decisions = yield* Effect.all(
        Array.from({ length: 8 }, (_, i) =>
          guard.evaluate({
            instanceId,
            threadId: ThreadId.make(`agent-${i}`),
            model: "claude-sonnet-5",
            purpose: "background",
          }),
        ),
        { concurrency: "unbounded" },
      );
      // 54% spent a quarter of the way through the window is past the bar, so
      // every background agent waits. The old one-in, seven-out split came from
      // an admission stopwatch; judging tokens against the clock gives all
      // eight the same answer, and thread concurrency is the scheduler's job.
      expect(decisions.filter((decision) => decision.action !== "pause")).toHaveLength(0);
      expect(decisions.filter((decision) => decision.action === "pause")).toHaveLength(8);
      const before = yield* guard.evaluate({
        instanceId,
        model: "claude-sonnet-5",
        purpose: "running",
      });
      for (let i = 0; i < 6; i++)
        yield* guard.recordTokens({ instanceId, model: "claude-sonnet-5", tokens: 150_000 });
      const after = yield* guard.evaluate({
        instanceId,
        model: "claude-sonnet-5",
        purpose: "running",
      });
      expect(after.evaluation.backgroundCooldownMs!).toBeGreaterThan(
        before.evaluation.backgroundCooldownMs!,
      );
      yield* TestClock.adjust("4 hours");
      const reset = yield* guard.evaluate({
        instanceId,
        model: "claude-sonnet-5",
        purpose: "background",
      });
      expect(reset.action).toBe("allow");
    }).pipe(Effect.provide(layer)),
);

it.effect("never holds a message the person typed, however spent the window is", () =>
  Effect.gen(function* () {
    const guard = yield* ProviderUsageGuard;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const now = yield* DateTime.now;
    yield* guard.recordRateLimits({
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      reportedAt: DateTime.formatIso(now),
      rateLimits: {
        rate_limits: {
          five_hour: {
            utilization: 99,
            resets_at: DateTime.formatIso(DateTime.add(now, { minutes: 200 })),
          },
        },
      },
    });
    const background = yield* guard.evaluate({
      instanceId,
      threadId: ThreadId.make("agent-thread"),
      model: "claude-sonnet-5",
      purpose: "background",
    });
    expect(background.action).toBe("pause");
    expect(background.evaluation.tier).toBe("pause");
    // Same window, same instant. Holding work nobody asked for is the point of
    // the guard; holding the message the person just typed points their own
    // reserve at them, and nothing lifts it while usage stays high — observed
    // 2026-09-07 as queued messages parked for 20+ minutes. Their turn goes at
    // reduced effort and the provider gets to raise its own error if it must.
    const typed = yield* guard.evaluate({
      instanceId,
      threadId: ThreadId.make("agent-thread"),
      model: "claude-sonnet-5",
      purpose: "user-turn",
    });
    expect(typed.evaluation.tier).toBe("pause");
    expect(typed.action).toBe("optimize");
  }).pipe(Effect.provide(layer)),
);

it.effect("applying effort persists the choice and rechecks without a resume override", () => {
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const guard = yield* ProviderUsageGuard;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const threadId = ThreadId.make("held-thread");
    const now = yield* DateTime.now;
    yield* guard.recordRateLimits({
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      reportedAt: DateTime.formatIso(now),
      rateLimits: {
        rate_limits: {
          five_hour: {
            utilization: 100,
            resets_at: DateTime.formatIso(DateTime.add(now, { hours: 4 })),
          },
        },
      },
    });
    const selection = {
      instanceId,
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "low" }],
    };
    yield* guard.resumeThread({ threadId, recheckOnly: true, modelSelection: selection });
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "thread.meta.update", modelSelection: selection }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "thread.activity.append",
        activity: expect.objectContaining({ kind: "usage-guard.effort-selected" }),
      }),
    );
    expect(
      commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "usage-guard.resumed",
      ),
    ).toBe(false);
    const decision = yield* guard.evaluate({
      instanceId,
      threadId,
      purpose: "background",
      model: selection.model,
      effort: "low",
    });
    expect(decision.overridden).toBe(false);
    // A spent window with no credits no longer holds: the guard steps aside
    // and lets the provider raise its own insufficient-credit error.
    expect(decision.action).toBe("optimize");
  }).pipe(Effect.provide(makeLayer(commands)));
});

it.effect("quotes Fable and regular models against their own applicable windows", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-06T18:00:00Z",
    slashCommands: [],
    skills: [],
    models: ["claude-fable-5-1", "claude-sonnet-5"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            type: "select",
            id: "effort",
            label: "Effort",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
  };
  return Effect.gen(function* () {
    const guard = yield* ProviderUsageGuard;
    const now = yield* DateTime.now;
    yield* guard.recordRateLimits({
      instanceId,
      driver: provider.driver,
      reportedAt: DateTime.formatIso(now),
      rateLimits: {
        rate_limits: {
          seven_day: {
            utilization: 10,
            resets_at: DateTime.formatIso(DateTime.add(now, { days: 2 })),
          },
          seven_day_fable: {
            utilization: 100,
            resets_at: DateTime.formatIso(DateTime.add(now, { days: 2 })),
          },
        },
      },
    });
    const decision = yield* guard.evaluate({
      instanceId,
      model: "claude-fable-5-1",
      effort: "high",
      purpose: "background",
    });
    // A spent window with no credits no longer holds: the guard steps aside
    // and lets the provider raise its own insufficient-credit error.
    expect(decision.action).toBe("optimize");
    const fable = decision.effortEstimates?.find(
      (quote) => quote.model === "claude-fable-5-1" && quote.effort === "low",
    );
    const regular = decision.effortEstimates?.find(
      (quote) => quote.model === "claude-sonnet-5" && quote.effort === "low",
    );
    // Fable's own window is spent, so it is not offered as available even
    // though the guard no longer holds work on its account.
    expect(fable?.resumeAt).toBeNull();
    expect(fable?.windowLabel).toContain("Fable");
    expect(regular?.resumeAt).toBe(DateTime.toEpochMillis(now));
    expect(regular?.optionId).toBe("effort");
    expect(regular?.windowLabel).not.toContain("Fable");
  }).pipe(Effect.provide(makeLayer([], [provider])));
});

it.effect("quotes the whole catalog, including models with no effort control", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const slugs = Array.from({ length: 20 }, (_, index) => `model-${index}`);
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-06T18:00:00Z",
    slashCommands: [],
    skills: [],
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      // Every other model exposes no effort control at all.
      capabilities:
        index % 2 === 0
          ? {
              optionDescriptors: [
                {
                  type: "select" as const,
                  id: "effort",
                  label: "Effort",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }
          : {},
    })),
  };
  return Effect.gen(function* () {
    const guard = yield* ProviderUsageGuard;
    const now = yield* DateTime.now;
    yield* guard.recordRateLimits({
      instanceId,
      driver: provider.driver,
      reportedAt: DateTime.formatIso(now),
      rateLimits: {
        rate_limits: {
          seven_day: {
            utilization: 40,
            resets_at: DateTime.formatIso(DateTime.add(now, { days: 2 })),
          },
        },
      },
    });
    const decision = yield* guard.evaluate({
      instanceId,
      model: "model-0",
      effort: "high",
      purpose: "background",
    });
    const quoted = new Set((decision.effortEstimates ?? []).map((quote) => quote.model));
    expect([...quoted].sort()).toEqual([...slugs].sort());
    // A model with no effort slider still gets one quote, under a default effort.
    const plain = (decision.effortEstimates ?? []).filter((quote) => quote.model === "model-1");
    expect(plain).toHaveLength(1);
    expect(plain[0]?.optionId).toBeUndefined();
  }).pipe(Effect.provide(makeLayer([], [provider])));
});

it.effect("refreshes a stale reading from the provider before judging held work", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const reportedAt = "2026-09-06T18:00:00Z";
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: reportedAt,
    slashCommands: [],
    skills: [],
    models: [{ slug: "claude-sonnet-5", name: "Sonnet", isCustom: false, capabilities: null }],
    // What a health probe reports: the account is now exhausted.
    accountUsage: {
      rate_limits: {
        seven_day: { utilization: 100, resets_at: "2026-09-08T18:00:00Z" },
      },
    },
    accountUsageReportedAt: reportedAt,
  };
  // The registry mock hands back this very array, so filling it after the
  // layer booted models a report that arrives only when the guard asks.
  const probed: ServerProvider[] = [];
  return Effect.gen(function* () {
    const guard = yield* ProviderUsageGuard;
    // Nothing reported yet: the guard has no reason to hold.
    const before = yield* guard.evaluate({
      instanceId,
      model: "claude-sonnet-5",
      purpose: "background",
    });
    expect(before.action).toBe("allow");
    expect(before.reportedAt).toBeNull();
    probed.push(provider);
    const first = yield* guard.refreshUsage({ instanceId });
    expect(first.refreshed).toBe(true);
    // Stamped with the guard's clock at fold time (the TestClock here), not the
    // provider's own string — what matters is that a reading now exists.
    expect(first.reportedAt).not.toBeNull();
    const after = yield* guard.evaluate({
      instanceId,
      model: "claude-sonnet-5",
      purpose: "background",
    });
    // A spent window with no credits no longer holds: the guard steps aside
    // and lets the provider raise its own insufficient-credit error.
    expect(after.action).toBe("optimize");
    expect(after.reportedAt).toBe(first.reportedAt);
    // A reading younger than the max age is not re-fetched.
    const second = yield* guard.refreshUsage({ instanceId, maxAgeMs: Number.POSITIVE_INFINITY });
    expect(second.refreshed).toBe(false);
  }).pipe(Effect.provide(makeLayer([], probed)));
});

const LearnedWindows = Schema.Struct({
  instances: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({ learnedTokensPerPercent: Schema.Number, calibrationSamples: Schema.Number }),
    ),
  ),
});
const decodeLearned = Schema.decodeUnknownEffect(Schema.fromJsonString(LearnedWindows));

const reportFiveHour =
  (guard: ProviderUsageGuard["Service"], now: DateTime.Utc) => (utilization: number) =>
    guard.recordRateLimits({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      reportedAt: DateTime.formatIso(now),
      rateLimits: {
        rate_limits: {
          five_hour: {
            utilization,
            resets_at: DateTime.formatIso(DateTime.add(now, { minutes: 200 })),
          },
        },
      },
    });

it.effect("carries a measured tokens-per-percent across a restart", () =>
  // Re-learning from scratch on every launch would leave the guard on the
  // driver default — the guess that priced a turn at 380x its real cost — for
  // the whole of each session's first stretch of work, because a window has to
  // climb five points before it teaches anything.
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-guard-restart-" });
    yield* fileSystem.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(baseDir, "userdata", "usage-guard-calibration.json"),
      `{"version":1,"instances":{"claudeAgent":{"five_hour":{"learnedTokensPerPercent":760000000,"calibrationSamples":4}}}}`,
    );
    const decision = yield* Effect.gen(function* () {
      const guard = yield* ProviderUsageGuard;
      const now = yield* DateTime.now;
      yield* reportFiveHour(guard, now)(20);
      return yield* guard.evaluate({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5",
        purpose: "background",
      });
    }).pipe(Effect.provide(makeLayer([], [], baseDir)));
    // The first report replaces every other field on the window; the measured
    // ratio is the one thing that has to survive it.
    expect(decision.evaluation.tokensPerPercentSource).toBe("learned");
    expect(decision.evaluation.tokensPerPercent).toBe(760_000_000);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("writes a measured tokens-per-percent to disk as soon as it has one", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-guard-flush-" });
    yield* Effect.gen(function* () {
      const guard = yield* ProviderUsageGuard;
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const now = yield* DateTime.now;
      const report = reportFiveHour(guard, now);
      yield* report(20);
      // 100M Sonnet tokens (multiplier 1) bought the climb from 20 to 30, so a
      // point of this window costs 10M. recordTokens flushes, so the write is
      // covered by the same call that banks the spend.
      yield* guard.recordTokens({ instanceId, model: "claude-sonnet-5", tokens: 100_000_000 });
      yield* report(30);
      yield* guard.recordTokens({ instanceId, model: "claude-sonnet-5", tokens: 1 });
    }).pipe(Effect.provide(makeLayer([], [], baseDir)));
    const written = yield* decodeLearned(
      yield* fileSystem.readFileString(
        path.join(baseDir, "userdata", "usage-guard-calibration.json"),
      ),
    );
    expect(written.instances.claudeAgent?.five_hour).toEqual({
      learnedTokensPerPercent: 10_000_000,
      calibrationSamples: 1,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
