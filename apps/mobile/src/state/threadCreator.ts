import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createThreadCreatorLabelAtoms } from "@t3tools/client-runtime/state/thread-provenance";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadShells } from "./threads";
import { vmAgentEnvironment } from "./vmAgents";

const threadCreatorLabelAtom = createThreadCreatorLabelAtoms({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  agentsAtom: (environmentId) => vmAgentEnvironment.agents({ environmentId, input: {} }),
});

const NO_CREATOR_LABEL_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mobile-thread-creator-label:none"),
);

/** "Created by …" for a thread another chat opened, or null for one the person started. */
export function useThreadCreatorLabel(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "createdByThreadId">,
): string | null {
  return useAtomValue(
    thread.createdByThreadId == null
      ? NO_CREATOR_LABEL_ATOM
      : threadCreatorLabelAtom({
          environmentId: thread.environmentId,
          threadId: thread.createdByThreadId,
        }),
  );
}
