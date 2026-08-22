import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { revertComposerSettingsToThread } from "./composerSettingsRevert";

describe("revertComposerSettingsToThread", () => {
  it("restores the authoritative provider, model options, runtime mode, and interaction mode", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const composerTarget = "promoting-draft";
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "max" },
        { id: "serviceTier", value: "priority" },
      ],
    } as const;
    const setModelSelection = vi.fn();
    const setRuntimeMode = vi.fn();
    const setInteractionMode = vi.fn();

    revertComposerSettingsToThread({
      composerTarget,
      thread: {
        environmentId,
        id: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "agent",
      },
      setModelSelection,
      setRuntimeMode,
      setInteractionMode,
    });

    expect(setModelSelection).toHaveBeenCalledWith(
      scopeThreadRef(environmentId, threadId),
      modelSelection,
      { replaceOptions: true },
    );
    expect(setRuntimeMode).toHaveBeenCalledWith(composerTarget, "full-access");
    expect(setInteractionMode).toHaveBeenCalledWith(composerTarget, "agent");
  });

  it("replaces missing authoritative model options instead of preserving staged ones", () => {
    const setModelSelection = vi.fn();

    revertComposerSettingsToThread({
      composerTarget: "thread-composer",
      thread: {
        environmentId: EnvironmentId.make("environment-1"),
        id: ThreadId.make("thread-1"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
      setModelSelection,
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    });

    expect(setModelSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ options: expect.anything() }),
      { replaceOptions: true },
    );
  });
});
