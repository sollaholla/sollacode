import type { VmAgentInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import type { VmCapturedFrame } from "../../../vm/VmProvider.ts";
import { VmComputerToolkit } from "./tools.ts";
import {
  VmComputerCapabilityUnavailableError,
  VmComputerFailedError,
  VmComputerInvalidInputError,
  VmComputerNoAgentError,
  VmComputerScreenshot,
  VmComputerUserControlActiveError,
  type VmComputerInput,
} from "./types.ts";

const MAX_WAIT_MS = 5_000;

const toScreenshot = (frame: VmCapturedFrame): VmComputerScreenshot => ({
  mimeType: "image/png",
  data: frame.data,
  width: frame.width,
  height: frame.height,
});

export const handleVmComputer = Effect.fn("VmComputer.handle")(function* (input: VmComputerInput) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("vm")) {
    return yield* new VmComputerCapabilityUnavailableError({ threadId: invocation.threadId });
  }

  const store = yield* VmAgentStore;
  const manager = yield* VmManager;

  const agentOption = yield* store
    .getByThreadId(invocation.threadId)
    .pipe(
      Effect.mapError(
        () =>
          new VmComputerFailedError({ operation: "resolving the agent", detail: "store error" }),
      ),
    );
  if (Option.isNone(agentOption)) {
    return yield* new VmComputerNoAgentError({ threadId: invocation.threadId });
  }
  const vmAgentId = agentOption.value.vmAgentId;

  // Translate the manager's error channel into readable, tool-local failures.
  const mapAgentError = (operation: string) => (error: unknown) => {
    if (error && typeof error === "object" && "_tag" in error) {
      const tag = (error as { _tag: string })._tag;
      if (tag === "VmUserControlActiveError") {
        return new VmComputerUserControlActiveError({ vmAgentId });
      }
      if (tag === "VmAgentNotFoundError") {
        return new VmComputerNoAgentError({ threadId: invocation.threadId });
      }
    }
    const detail =
      error instanceof Error && error.message ? error.message : "the VM may not be running";
    return new VmComputerFailedError({ operation, detail });
  };

  const capture = (operation: string) =>
    manager.agentScreenshot(vmAgentId).pipe(Effect.mapError(mapAgentError(operation)));
  const send = (operation: string, event: VmAgentInput) =>
    manager.agentInput(vmAgentId, event).pipe(Effect.mapError(mapAgentError(operation)));

  const requirePoint = (): Effect.Effect<{ x: number; y: number }, VmComputerInvalidInputError> => {
    if (typeof input.x !== "number") {
      return Effect.fail(new VmComputerInvalidInputError({ action: input.action, missing: "x" }));
    }
    if (typeof input.y !== "number") {
      return Effect.fail(new VmComputerInvalidInputError({ action: input.action, missing: "y" }));
    }
    return Effect.succeed({ x: input.x, y: input.y });
  };
  const button = input.button ?? "left";

  const result = (action: string, status: string, frame: VmCapturedFrame) => ({
    action,
    status,
    ...(frame.cursor ? { cursor: frame.cursor } : {}),
    screenshot: toScreenshot(frame),
  });

  switch (input.action) {
    case "screenshot": {
      const frame = yield* capture("taking a screenshot");
      return result("screenshot", "Captured the screen.", frame);
    }
    case "move": {
      const point = yield* requirePoint();
      yield* send("moving the pointer", { type: "pointer", action: "move", ...point, button });
      const frame = yield* capture("taking a screenshot");
      return result(
        "move",
        `Moved the pointer to (${point.x.toFixed(3)}, ${point.y.toFixed(3)}).`,
        frame,
      );
    }
    case "click":
    case "double_click": {
      const point = yield* requirePoint();
      const clicks = input.action === "double_click" ? 2 : 1;
      for (let i = 0; i < clicks; i++) {
        yield* send("clicking", { type: "pointer", action: "down", ...point, button });
        yield* send("clicking", { type: "pointer", action: "up", ...point, button });
      }
      const frame = yield* capture("taking a screenshot");
      return result(
        input.action,
        `${input.action === "double_click" ? "Double-clicked" : "Clicked"} the ${button} button.`,
        frame,
      );
    }
    case "type": {
      if (typeof input.text !== "string" || input.text.length === 0) {
        return yield* new VmComputerInvalidInputError({ action: input.action, missing: "text" });
      }
      yield* send("typing", { type: "text", text: input.text });
      const frame = yield* capture("taking a screenshot");
      return result("type", `Typed ${input.text.length} character(s).`, frame);
    }
    case "key": {
      if (typeof input.keys !== "string" || input.keys.length === 0) {
        return yield* new VmComputerInvalidInputError({ action: input.action, missing: "keys" });
      }
      yield* send("pressing keys", { type: "press", keys: input.keys });
      const frame = yield* capture("taking a screenshot");
      return result("key", `Pressed ${input.keys}.`, frame);
    }
    case "scroll": {
      const point = yield* requirePoint();
      yield* send("scrolling", {
        type: "scroll",
        ...point,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
      });
      const frame = yield* capture("taking a screenshot");
      return result("scroll", `Scrolled by (${input.deltaX ?? 0}, ${input.deltaY ?? 0}).`, frame);
    }
    case "wait": {
      const ms = Math.min(MAX_WAIT_MS, Math.max(0, input.ms ?? 500));
      yield* Effect.sleep(Duration.millis(ms));
      const frame = yield* capture("taking a screenshot");
      return result("wait", `Waited ${ms}ms.`, frame);
    }
  }
});

const handlers = {
  vm_computer: handleVmComputer,
} satisfies Parameters<typeof VmComputerToolkit.toLayer>[0];

export const VmComputerToolkitHandlersLive = VmComputerToolkit.toLayer(handlers);
