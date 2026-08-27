import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    correctVoiceTranscript: () =>
      Effect.die("correctVoiceTranscript stub not configured for this test"),
    generatePlanRefresh: () => Effect.die("generatePlanRefresh stub not configured for this test"),
    generateVmAgentTaskPrompt: () =>
      Effect.die("generateVmAgentTaskPrompt stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {
      capabilities: { textGeneration: true },
    } as ProviderInstance["adapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("routes voice correction through its dedicated model selection", () =>
    Effect.gen(function* () {
      const fastId = ProviderInstanceId.make("codex_fast_voice");
      const calls: TextGeneration.VoiceTranscriptCorrectionGenerationInput[] = [];
      const fast = makeStubInstance(
        fastId,
        makeStubTextGeneration({
          correctVoiceTranscript: (input) => {
            calls.push(input);
            return Effect.succeed({ transcript: "Open the Veera Medical project." });
          },
        }),
      );
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([fast]));
      const modelSelection = createModelSelection(fastId, "gpt-5-mini");

      const result = yield* tg.correctVoiceTranscript({
        cwd: process.cwd(),
        transcript: "Open the Vera medical project.",
        conversationContext: "User: We are working on Veera Medical.",
        modelSelection,
      });

      expect(result.transcript).toBe("Open the Veera Medical project.");
      expect(calls).toEqual([
        {
          cwd: process.cwd(),
          transcript: "Open the Vera medical project.",
          conversationContext: "User: We are working on Veera Medical.",
          modelSelection,
        },
      ]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );

  it.effect("excludes a provider instance that advertises text generation as unsupported", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("external_without_text_generation");
      let delegated = false;
      const instance = {
        ...makeStubInstance(
          instanceId,
          makeStubTextGeneration({
            generateThreadTitle: () => {
              delegated = true;
              return Effect.succeed({ title: "must not run" });
            },
          }),
        ),
        adapter: {
          capabilities: { textGeneration: false },
        } as ProviderInstance["adapter"],
      } satisfies ProviderInstance;
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread",
          modelSelection: createModelSelection(instanceId, "fake-model"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(delegated).toBe(false);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.detail).toContain("does not advertise text-generation support");
      }
    }),
  );
});
