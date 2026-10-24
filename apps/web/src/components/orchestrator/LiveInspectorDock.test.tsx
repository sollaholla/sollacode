// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { Subtitle } from "../../orchestrator/liveInspector";
import type { OrchestratorThreadTarget } from "../../orchestrator/useOrchestratorThread";
import { LiveInspectorDock } from "./LiveInspectorDock";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.enqueue }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { enqueueTurn: {} } }));

const environmentId = EnvironmentId.make("host");
const threadId = ThreadId.make("solla-orchestrator");
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const orchestrator = {
  ref: { environmentId, threadId },
  shell: {
    id: threadId,
    environmentId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
} as unknown as OrchestratorThreadTarget;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness({ subtitle = null }: { subtitle?: Subtitle | null }) {
  const [open, setOpen] = useState(false);
  return (
    <LiveInspectorDock
      orchestrator={orchestrator}
      subtitle={subtitle}
      orchestratorWorking={false}
      composerOpen={open}
      onComposerOpenChange={setOpen}
    />
  );
}

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}

function textarea(): HTMLTextAreaElement {
  const found = document.querySelector("textarea");
  if (!found) throw new Error("The message box is not open");
  return found;
}

async function type(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter() {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

async function openComposer() {
  const chat = document.querySelector<HTMLButtonElement>("[data-testid=live-inspector-chat]");
  if (!chat) throw new Error("Missing chat button");
  await act(async () => chat.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.enqueue.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("sends what is typed to the orchestrator thread, on its own settings", async () => {
  await render(<Harness />);
  await openComposer();
  expect(document.activeElement).toBe(textarea());

  await type("  What is Fieldwork doing?  ");
  await pressEnter();

  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  const [command] = mocks.enqueue.mock.calls[0]!;
  expect(command).toMatchObject({
    environmentId,
    input: {
      threadId,
      message: { role: "user", text: "What is Fieldwork doing?", attachments: [] },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    },
  });
  // Sent: the box closes and the chat button is back.
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.querySelector("[data-testid=live-inspector-chat]")).not.toBeNull();
});

it("keeps the words and says so when a send fails", async () => {
  mocks.enqueue.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
  await render(<Harness />);
  await openComposer();
  await type("Pause the trading desk");
  await pressEnter();

  expect(textarea().value).toBe("Pause the trading desk");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't send");
});

it("runs the conversation as subtitles", async () => {
  await render(
    <Harness
      subtitle={{
        key: "env:reply",
        speaker: "orchestrator",
        text: "Fieldwork is rerunning its tests.",
        live: true,
      }}
    />,
  );
  expect(document.querySelector("[data-testid=live-inspector-subtitle]")?.textContent).toBe(
    "Orchestrator: Fieldwork is rerunning its tests.",
  );
});
