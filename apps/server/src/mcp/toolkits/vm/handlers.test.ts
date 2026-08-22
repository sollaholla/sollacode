import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VmAgent,
  VmAgentId,
  VmId,
  VmUserControlActiveError,
  type VmAgentInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import type { VmCapturedFrame } from "../../../vm/VmProvider.ts";
import { handleVmComputer } from "./handlers.ts";

const threadId = ThreadId.make("thread-scout");
const vmAgentId = VmAgentId.make("agent-scout");

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["vm"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-vm-test"),
  threadId,
  providerSessionId: "provider-session-scout",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities,
  issuedAt: 1,
});

const agent: VmAgent = {
  vmAgentId,
  name: "Scout",
  handle: "scout",
  purpose: "browse the web",
  vmId: VmId.make("vm-scout"),
  threadId,
  status: "running",
  controlMode: "agent",
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

const frame: VmCapturedFrame = {
  width: 320,
  height: 200,
  format: "png",
  data: "AAAA",
  cursor: { x: 160, y: 100 },
};

const makeHarness = (options: {
  readonly boundAgent?: VmAgent | null;
  readonly screenshot?: Effect.Effect<VmCapturedFrame, VmUserControlActiveError>;
}) => {
  const inputs: VmAgentInput[] = [];
  const storeLayer = Layer.mock(VmAgentStore)({
    getByThreadId: () =>
      Effect.succeed(
        options.boundAgent === null || options.boundAgent === undefined
          ? Option.none()
          : Option.some(options.boundAgent),
      ),
  });
  const managerLayer = Layer.mock(VmManager)({
    agentScreenshot: () => options.screenshot ?? Effect.succeed(frame),
    agentInput: (_id: VmAgentId, event: VmAgentInput) =>
      Effect.sync(() => {
        inputs.push(event);
      }),
  });
  return { inputs, layer: Layer.mergeAll(storeLayer, managerLayer) };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, McpInvocationContext.McpInvocationContext | VmAgentStore | VmManager>,
  layer: Layer.Layer<VmAgentStore | VmManager>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provide(layer),
  );

it.effect("rejects a call without the vm capability", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({ boundAgent: agent });
    const error = yield* Effect.flip(
      run(handleVmComputer({ action: "screenshot" }), layer, new Set(["terminals"])),
    );
    assert.strictEqual(error._tag, "VmComputerCapabilityUnavailableError");
  }),
);

it.effect("reports when the thread is not a VM agent", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({ boundAgent: null });
    const error = yield* Effect.flip(run(handleVmComputer({ action: "screenshot" }), layer));
    assert.strictEqual(error._tag, "VmComputerNoAgentError");
  }),
);

it.effect("returns a screenshot with the frame data and dimensions", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({ boundAgent: agent });
    const result = yield* run(handleVmComputer({ action: "screenshot" }), layer);
    assert.strictEqual(result.action, "screenshot");
    assert.strictEqual(result.screenshot.data, "AAAA");
    assert.strictEqual(result.screenshot.width, 320);
    assert.deepStrictEqual(result.cursor, { x: 160, y: 100 });
  }),
);

it.effect("translates a click into pointer down/up and returns a fresh screenshot", () =>
  Effect.gen(function* () {
    const { inputs, layer } = makeHarness({ boundAgent: agent });
    const result = yield* run(handleVmComputer({ action: "click", x: 0.5, y: 0.5 }), layer);
    assert.strictEqual(result.action, "click");
    assert.deepStrictEqual(
      inputs.map((event) => event.type === "pointer" && event.action),
      ["down", "up"],
    );
    assert.isString(result.screenshot.data);
  }),
);

it.effect("requires coordinates for a click", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({ boundAgent: agent });
    const error = yield* Effect.flip(run(handleVmComputer({ action: "click" }), layer));
    assert.strictEqual(error._tag, "VmComputerInvalidInputError");
  }),
);

it.effect("surfaces user takeover as a tool error", () =>
  Effect.gen(function* () {
    const { layer } = makeHarness({
      boundAgent: agent,
      screenshot: Effect.fail(new VmUserControlActiveError({ vmAgentId })),
    });
    const error = yield* Effect.flip(run(handleVmComputer({ action: "screenshot" }), layer));
    assert.strictEqual(error._tag, "VmComputerUserControlActiveError");
  }),
);
