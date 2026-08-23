import type { EnvironmentId, VmAgentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";

import { agentDeletionMismatchHint, canConfirmAgentDeletion } from "./deleteAgentConfirmation";

/**
 * Confirms deleting an agent by making the user type its name.
 *
 * The delete affordances live on rows that look alike — a hover X on desktop,
 * a swipe on touch — so the gesture is easy to aim at the wrong one. This is
 * the only step in the flow that requires knowing which agent is actually
 * under the cursor.
 */
export function DeleteAgentDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly agentId: VmAgentId;
  readonly agentName: string;
  /** Runs after the agent is gone, for callers that must leave its route. */
  readonly onDeleted?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleteAgent = useAtomCommand(vmAgentEnvironment.delete, { reportFailure: false });

  // Reopening for a different agent must not inherit the previous attempt's
  // typing, which could already spell a name that now authorises nothing.
  useEffect(() => {
    if (!props.open) return;
    setTyped("");
    setError(null);
    setBusy(false);
  }, [props.open, props.agentId]);

  const confirmed = canConfirmAgentDeletion({ agentName: props.agentName, typed });
  const hint = agentDeletionMismatchHint({ agentName: props.agentName, typed });

  const submit = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteAgent({
      environmentId: props.environmentId,
      input: { vmAgentId: props.agentId },
    });
    if (result._tag === "Success") {
      props.onOpenChange(false);
      props.onDeleted?.();
      return;
    }
    const squashed = Cause.squash(result.cause);
    setError(
      squashed instanceof Error && squashed.message.trim().length > 0
        ? squashed.message
        : "Could not delete the agent.",
    );
    setBusy(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full max-w-md min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <TriangleAlertIcon className="size-4" />
            </span>
            Delete {props.agentName}
          </DialogTitle>
          <DialogDescription>
            This destroys the agent&apos;s virtual machine, its scheduled tasks and its whole
            history. It cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="delete-agent-name">
            Type <span className="font-semibold text-foreground">{props.agentName}</span> to confirm
          </label>
          <Input
            id="delete-agent-name"
            value={typed}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={hint !== null}
            placeholder={props.agentName}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={() => void submit()}
          >
            {busy ? "Deleting…" : "Delete agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
