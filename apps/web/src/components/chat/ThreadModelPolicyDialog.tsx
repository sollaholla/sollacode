import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  modelAccessPoliciesAllow,
  threadModelPolicyChain,
} from "@t3tools/shared/modelAccessPolicy";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { ModelPolicyEditor, useSaveModelPolicy } from "../settings/ModelPolicyEditor";

export function useThreadModelPolicy(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const shells = useThreadShells();
  const byId = useMemo(
    () =>
      new Map(
        shells
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => [String(thread.id), thread]),
      ),
    [shells, environmentId],
  );
  const chain = useMemo(
    () =>
      threadId
        ? threadModelPolicyChain({
            threadId,
            policies: settings.threadModelPolicies,
            getParent: (id) => {
              const thread = byId.get(id);
              return thread ? (thread.sideChatParentThreadId ?? null) : undefined;
            },
          })
        : { policies: [], complete: true },
    [threadId, settings.threadModelPolicies, byId],
  );
  const directParent = threadId ? byId.get(threadId)?.sideChatParentThreadId : null;
  const disabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (
        (!chain.complete && Object.keys(settings.threadModelPolicies).length > 0) ||
        !modelAccessPoliciesAllow(chain.policies, { instanceId, model })
      )
        return "Blocked by this chat or its parent agent’s model restrictions";
      return null;
    },
    [chain, settings.threadModelPolicies],
  );
  return {
    settings,
    directParent,
    disabledReason,
  };
}

export function ThreadModelPolicyDialog(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { settings, directParent } = useThreadModelPolicy(props.environmentId, props.threadId);
  const [scope, setScope] = useState<"chat" | "parent">("chat");
  const targetId = scope === "parent" && directParent ? directParent : props.threadId;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const save = useSaveModelPolicy(props.environmentId);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-h-[85dvh] overflow-y-auto p-5">
        <DialogTitle>Model restrictions</DialogTitle>
        <DialogDescription className="mt-2 mb-4">
          Control which models this chat and its side chats can use. Parent agent restrictions also
          apply. If no permitted fallback is available, work stops without switching to a blocked
          model.
        </DialogDescription>
        {directParent && (
          <label className="mb-4 grid gap-1 text-sm">
            Apply to
            <select
              aria-label="Restriction scope"
              className="rounded-md border border-border bg-background p-2"
              value={scope}
              onChange={(event) => setScope(event.target.value as "chat" | "parent")}
            >
              <option value="chat">This side chat</option>
              <option value="parent">Parent agent or chat and all its side chats</option>
            </select>
          </label>
        )}
        <ModelPolicyEditor
          key={targetId}
          policy={settings.threadModelPolicies[targetId]}
          providers={providers ?? []}
          onSave={(policy) => save({ threadModelPolicies: { [targetId]: policy } })}
        />
      </DialogPopup>
    </Dialog>
  );
}
