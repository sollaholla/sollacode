import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  consumeTerminalGeometryActivation,
  requestTerminalGeometryActivation,
} from "./terminalGeometryActivation";

const thread = scopeThreadRef(EnvironmentId.make("host"), ThreadId.make("thread"));
afterEach(() => vi.useRealTimers());

it("carries one deliberate activation only to the intended environment, thread, pane and surface", () => {
  requestTerminalGeometryActivation(thread, "term-1", "right-panel");
  expect(consumeTerminalGeometryActivation(thread, "term-1", "drawer")).toBe(false);
  expect(consumeTerminalGeometryActivation(thread, "term-2", "right-panel")).toBe(false);
  expect(
    consumeTerminalGeometryActivation(
      { ...thread, environmentId: EnvironmentId.make("other") },
      "term-1",
      "right-panel",
    ),
  ).toBe(false);
  expect(
    consumeTerminalGeometryActivation(
      { ...thread, threadId: ThreadId.make("other") },
      "term-1",
      "right-panel",
    ),
  ).toBe(false);
  expect(consumeTerminalGeometryActivation(thread, "term-1", "right-panel")).toBe(true);
  expect(consumeTerminalGeometryActivation(thread, "term-1", "right-panel")).toBe(false);
});

it("uses the newest activation and drops an abandoned open after the activity window", () => {
  vi.useFakeTimers();
  requestTerminalGeometryActivation(thread, "term-1");
  requestTerminalGeometryActivation(thread, "term-2");
  expect(consumeTerminalGeometryActivation(thread, "term-1")).toBe(false);
  expect(consumeTerminalGeometryActivation(thread, "term-2")).toBe(true);
  requestTerminalGeometryActivation(thread);
  vi.advanceTimersByTime(30_001);
  expect(consumeTerminalGeometryActivation(thread, "term-1")).toBe(false);
});
