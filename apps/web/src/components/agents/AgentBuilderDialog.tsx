import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";

/**
 * Starts an Agent Builder chat from a single prompt.
 *
 * Deliberately not a form for the agent's fields: the point is that the chosen
 * model designs the whole agent — name, chat configuration, tasks, schedules,
 * notifications, artifact — in a dedicated chat with the agent_builder tool,
 * and the conversation stays open for follow-up adjustments.
 */
export function AgentBuilderDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
}) {
  const router = useRouter();
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const defaultSelection = resolveAppModelSelectionState(settings, serverProviders);

  const [prompt, setPrompt] = useState("");
  const [selection, setSelection] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }>({ instanceId: defaultSelection.instanceId, model: defaultSelection.model });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builderCreate = useAtomCommand(vmAgentEnvironment.builderCreate, { reportFailure: false });

  // Reopening is the user's way of starting over, so the fields reset with it.
  // Guarded on `open` so edits survive a re-render mid-session.
  useEffect(() => {
    if (!props.open) return;
    setPrompt("");
    setSelection({ instanceId: defaultSelection.instanceId, model: defaultSelection.model });
    setError(null);
    setBusy(false);
    // Re-seeding on every selection change would fight the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );

  const canSubmit = prompt.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await builderCreate({
      environmentId: props.environmentId,
      input: {
        prompt: prompt.trim(),
        modelSelection: { instanceId: selection.instanceId, model: selection.model },
      },
    });
    if (result._tag === "Failure") {
      const squashed = Cause.squash(result.cause);
      setError(
        squashed instanceof Error && squashed.message.trim().length > 0
          ? squashed.message
          : "The Agent Builder chat could not be started.",
      );
      setBusy(false);
      return;
    }
    props.onOpenChange(false);
    setBusy(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.environmentId, threadId: result.value.threadId },
    });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (busy) return;
        props.onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full max-w-lg min-w-0">
        <DialogHeader>
          <DialogTitle>Build an agent with AI</DialogTitle>
          <DialogDescription>
            Describe the agent you want. A dedicated chat on the model you pick designs and creates
            it end to end — name, tasks, schedules, notifications — and stays open for adjustments.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="agent-builder-prompt"
            >
              What should this agent do?
            </label>
            <Textarea
              id="agent-builder-prompt"
              value={prompt}
              autoFocus
              rows={5}
              maxLength={20_000}
              placeholder="Watch my open-source repos every morning, triage new issues, and keep a dashboard of what needs my attention…"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Builder model</span>
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              disabled={busy}
              triggerVariant="outline"
              triggerAriaLabel="Model that designs and builds the agent"
              onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Starting…" : "Start building"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
