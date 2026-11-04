import { deleteThreadArtifacts } from "@t3tools/client-runtime/state/thread-artifacts";
import type { ScopedThreadRef, ThreadArtifactId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { threadArtifactEnvironment } from "~/state/threadArtifacts";

import { EnvironmentArtifactIcon, useArtifactList } from "./ThreadArtifactShelf";

const plural = (count: number) => (count === 1 ? "1 artifact" : `${count} artifacts`);

/**
 * Picks several of a thread's artifacts and deletes them in one go. Opened from
 * the Artifacts menu; the list follows the host, so deleted rows drop out.
 */
export function ThreadArtifactBulkDeleteDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { result, list } = useArtifactList(props.threadRef);
  const artifacts = list?.artifacts ?? [];
  const [selected, setSelected] = useState<ReadonlySet<ThreadArtifactId>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failedCount, setFailedCount] = useState(0);
  const deleteArtifact = useAtomCommand(threadArtifactEnvironment.delete, {
    reportFailure: false,
  });

  // Only rows still listed count: another device may have deleted some already.
  const chosen = artifacts
    .map((summary) => summary.artifact.artifactId)
    .filter((artifactId) => selected.has(artifactId));
  const allSelected = artifacts.length > 0 && chosen.length === artifacts.length;

  const close = (open: boolean) => {
    if (deleting) return;
    if (!open) {
      setSelected(new Set());
      setConfirming(false);
      setFailedCount(0);
    }
    props.onOpenChange(open);
  };

  const toggle = (artifactId: ThreadArtifactId, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(artifactId);
      else next.delete(artifactId);
      return next;
    });
  };

  const performDelete = async () => {
    setDeleting(true);
    const failed = await deleteThreadArtifacts(chosen, async (artifactId) => {
      const outcome = await deleteArtifact({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, artifactId },
      });
      if (outcome._tag === "Failure") return false;
      // A tab showing a deleted artifact goes with it.
      useRightPanelStore.getState().closeSurface(props.threadRef, `artifact:${artifactId}`);
      return true;
    });
    setDeleting(false);
    setConfirming(false);
    setSelected(new Set(failed));
    setFailedCount(failed.length);
    if (failed.length === 0) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogPopup className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>
            {confirming ? `Delete ${plural(chosen.length)}?` : "Delete artifacts"}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? "They and every revision of them will be removed from this computer. Unlike archiving, this cannot be undone."
              : "Choose the artifacts this thread published that you no longer need."}
          </DialogDescription>
        </DialogHeader>
        {confirming ? null : (
          <div className="flex min-h-0 flex-col gap-1 px-6">
            {result._tag === "Failure" ? (
              <p className="text-xs text-destructive">
                Artifacts could not be loaded from this host.
              </p>
            ) : artifacts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {list === null ? "Loading artifacts…" : "This thread has no artifacts."}
              </p>
            ) : (
              <>
                <label className="flex min-h-9 cursor-pointer items-center gap-3 border-b border-border/70 px-2 text-xs font-medium text-muted-foreground">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={chosen.length > 0 && !allSelected}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? new Set(artifacts.map((summary) => summary.artifact.artifactId))
                          : new Set(),
                      )
                    }
                  />
                  Select all
                </label>
                <div className="max-h-80 min-w-0 overflow-y-auto">
                  {artifacts.map((summary) => {
                    const artifact = summary.artifact;
                    const checked = selected.has(artifact.artifactId);
                    return (
                      <label
                        key={artifact.artifactId}
                        className={cn(
                          "flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent",
                          checked && "bg-accent/60",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => toggle(artifact.artifactId, next)}
                        />
                        <EnvironmentArtifactIcon threadRef={props.threadRef} summary={summary} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {artifact.title}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {artifact.archivedAt !== null ? "Archived" : artifact.kind} · revision{" "}
                            {artifact.currentRevision}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            {failedCount > 0 ? (
              <p role="alert" className="text-xs text-destructive">
                {plural(failedCount)} could not be deleted and {failedCount === 1 ? "is" : "are"}{" "}
                still selected.
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {confirming ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={deleting}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => void performDelete()}
              >
                {deleting ? "Deleting…" : `Delete ${plural(chosen.length)}`}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={chosen.length === 0}
                onClick={() => setConfirming(true)}
              >
                {chosen.length === 0 ? "Delete" : `Delete ${plural(chosen.length)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
