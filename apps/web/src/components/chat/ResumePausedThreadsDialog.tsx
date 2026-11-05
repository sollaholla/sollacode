import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface PausedThreadChoice {
  readonly id: string;
  readonly title: string;
}

/**
 * Asked when Resume could bring back more than the chat in view: other chats
 * stopped on the same model. All are ticked, so resuming them is one click.
 */
export function ResumePausedThreadsDialog(props: {
  readonly open: boolean;
  readonly modelName: string;
  readonly threads: ReadonlyArray<PausedThreadChoice>;
  readonly onResume: (threadIds: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}) {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (props.open) setUnticked(new Set());
  }, [props.open]);
  const chosen = props.threads.filter((thread) => !unticked.has(thread.id));
  const total = chosen.length + 1;

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resume the others too?</DialogTitle>
          <DialogDescription>
            {props.threads.length === 1
              ? `1 other chat stopped on ${props.modelName}.`
              : `${props.threads.length} other chats stopped on ${props.modelName}.`}{" "}
            They come back one at a time, and stop if the provider refuses again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {props.threads.map((thread) => (
              <li key={thread.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent/50">
                  <Checkbox
                    checked={!unticked.has(thread.id)}
                    onCheckedChange={(checked) =>
                      setUnticked((current) => {
                        const next = new Set(current);
                        if (checked) next.delete(thread.id);
                        else next.add(thread.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{thread.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onResume([])}>
            Only this chat
          </Button>
          <Button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => props.onResume(chosen.map((thread) => thread.id))}
          >
            Resume {total} chats
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
