import type { EnvironmentId, VmAgent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";

export interface AgentRenameTarget {
  readonly environmentId: EnvironmentId;
  readonly agent: Pick<VmAgent, "vmAgentId" | "name" | "handle">;
}

/** Mount for one rename attempt; registry updates supply the saved name everywhere. */
export function RenameAgentDialog(props: AgentRenameTarget & { readonly onClose: () => void }) {
  const [name, setName] = useState(props.agent.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const nameId = useId();
  const errorId = useId();
  const rename = useAtomCommand(vmAgentEnvironment.rename, { reportFailure: false });
  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && trimmedName.length <= 64 && !busy;

  const submit = async () => {
    if (!canSave || saving.current) return;
    if (trimmedName === props.agent.name) {
      props.onClose();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    const result = await rename({
      environmentId: props.environmentId,
      input: { vmAgentId: props.agent.vmAgentId, name: trimmedName },
    });
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    const failure = Cause.squash(result.cause);
    setError(
      failure instanceof Error && failure.message.trim().length > 0
        ? failure.message
        : "Could not rename the agent.",
    );
    saving.current = false;
    setBusy(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.current) props.onClose();
      }}
    >
      <DialogPopup className="w-full max-w-md min-w-0">
        <DialogHeader>
          <DialogTitle>Rename agent</DialogTitle>
          <DialogDescription>
            Choose a name for {props.agent.name}. Its mention handle stays @{props.agent.handle}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor={nameId}>
            Name
          </label>
          <Input
            id={nameId}
            autoFocus
            autoComplete="off"
            maxLength={64}
            value={name}
            disabled={busy}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void submit()}>
            {busy ? "Saving…" : "Save name"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
