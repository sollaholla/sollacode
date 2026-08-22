import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import type { Thread } from "../../types";

export function revertComposerSettingsToThread<TComposerTarget>(input: {
  readonly composerTarget: TComposerTarget;
  readonly thread: Pick<
    Thread,
    "environmentId" | "id" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  readonly setModelSelection: (
    target: ScopedThreadRef,
    selection: ModelSelection,
    options: { readonly replaceOptions: true },
  ) => void;
  readonly setRuntimeMode: (target: TComposerTarget, mode: Thread["runtimeMode"]) => void;
  readonly setInteractionMode: (target: TComposerTarget, mode: Thread["interactionMode"]) => void;
}): void {
  input.setModelSelection(
    scopeThreadRef(input.thread.environmentId, input.thread.id),
    input.thread.modelSelection,
    { replaceOptions: true },
  );
  input.setRuntimeMode(input.composerTarget, input.thread.runtimeMode);
  input.setInteractionMode(input.composerTarget, input.thread.interactionMode);
}
