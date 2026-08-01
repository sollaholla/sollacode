import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  DEFAULT_GIT_INIT_INSTRUCTIONS,
  buildGitInitPrompt,
  canRunAssistedGitInit,
  canRunPlainGitInit,
} from "../gitInitPrompt";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { usePrimarySettings } from "../hooks/useSettings";
import { primaryServerProvidersAtom } from "../state/server";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
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

export interface GitInitDialogAssistedInput {
  readonly prompt: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/**
 * Choice of how to create the repository.
 *
 * The two actions sit side by side rather than behind a mode toggle because
 * they differ in cost, not just in configuration: one writes a `.git`
 * directory, the other spends a provider turn reading the whole project.
 */
export function GitInitDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cwd: string | null;
  readonly busy: boolean;
  readonly canUseProvider: boolean;
  readonly onPlainInit: () => void;
  readonly onAssistedInit: (input: GitInitDialogAssistedInput) => void;
}) {
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const [instructions, setInstructions] = useState(DEFAULT_GIT_INIT_INSTRUCTIONS);

  const defaultSelection = resolveAppModelSelectionState(settings, serverProviders);
  const [selection, setSelection] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }>({ instanceId: defaultSelection.instanceId, model: defaultSelection.model });

  // Reopening is the user's way of starting over, so the fields reset with it.
  // Guarded on `open` so edits survive a re-render mid-session.
  useEffect(() => {
    if (!props.open) return;
    setInstructions(DEFAULT_GIT_INIT_INSTRUCTIONS);
    setSelection({ instanceId: defaultSelection.instanceId, model: defaultSelection.model });
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

  const assistedEnabled =
    props.canUseProvider &&
    canRunAssistedGitInit({ cwd: props.cwd, instructions, busy: props.busy });
  const plainEnabled = canRunPlainGitInit({ cwd: props.cwd, busy: props.busy });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Initialize Git</DialogTitle>
          <DialogDescription>
            Have a provider read this project and set the repository up to match it — or just create
            an empty one.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="git-init-prompt">
              Instructions
            </label>
            <Textarea
              id="git-init-prompt"
              value={instructions}
              rows={10}
              spellCheck={false}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={DEFAULT_GIT_INIT_INSTRUCTIONS}
            />
            <p className="text-xs text-muted-foreground">
              {props.cwd
                ? `Runs against ${props.cwd} and every folder inside it.`
                : "No project directory is selected."}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Provider</span>
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              disabled={props.busy || !props.canUseProvider}
              triggerVariant="outline"
              triggerAriaLabel="Provider that initializes the repository"
              onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
            />
          </div>

          {props.canUseProvider ? null : (
            <p className="text-xs text-muted-foreground">
              Open a thread in this project to let a provider set the repository up for you.
            </p>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={!plainEnabled}
            onClick={() => props.onPlainInit()}
          >
            Just initialize Git
          </Button>
          <Button
            size="sm"
            disabled={!assistedEnabled}
            onClick={() => {
              if (props.cwd === null) return;
              props.onAssistedInit({
                prompt: buildGitInitPrompt({
                  cwd: props.cwd,
                  instructions,
                  // The repository is created first so the provider's very first
                  // command is not a `git init` race against ours.
                  alreadyInitialized: true,
                }),
                instanceId: selection.instanceId,
                model: selection.model,
              });
            }}
          >
            {props.busy ? "Initializing..." : "Initialize with AI"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
