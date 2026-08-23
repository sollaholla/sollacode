import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";
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
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

/**
 * Create a named agent. Each agent gets its own chat whose browser keeps
 * persistent logins; the name
 * doubles as its `@mention` handle, so it must be unique.
 */
export function CreateAgentDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createAgent = useAtomCommand(vmAgentEnvironment.create, { reportFailure: false });

  const reset = () => {
    setName("");
    setPurpose("");
    setError(null);
    setBusy(false);
  };

  const canSubmit = name.trim().length > 0 && purpose.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await createAgent({
      environmentId: props.environmentId,
      input: { name: name.trim(), purpose: purpose.trim() },
    });
    if (result._tag === "Success") {
      reset();
      props.onOpenChange(false);
      return;
    }
    const squashed = Cause.squash(result.cause);
    setError(
      squashed instanceof Error && squashed.message.trim().length > 0
        ? squashed.message
        : "Could not create the agent.",
    );
    setBusy(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) reset();
        props.onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full max-w-md min-w-0">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            A named autonomous agent with its own chat and persistent browser logins. The name is
            also its @mention handle.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="agent-name">
              Name
            </label>
            <Input
              id="agent-name"
              value={name}
              autoFocus
              maxLength={64}
              placeholder="Scout"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="agent-purpose">
              Purpose
            </label>
            <Textarea
              id="agent-purpose"
              value={purpose}
              rows={3}
              maxLength={2000}
              placeholder="Research topics in the browser and summarize findings."
              onChange={(event) => setPurpose(event.target.value)}
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
