import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { STORAGE_CLEANUP_DESCRIPTION } from "@t3tools/client-runtime/operations/storage-cleanup";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HostVitals,
  ProjectId,
  ThreadId,
  StorageCleanupStartInput,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HardDriveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { describeStorage, formatStorageBytes } from "./HostVitalsChip.logic";

type CleanupRequest = {
  readonly environmentId: EnvironmentId;
  readonly input: StorageCleanupStartInput;
};

type CleanupDestination = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
};

export function StorageCleanupPopover({
  environmentId,
  storage,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly storage: NonNullable<HostVitals["storage"]>;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const request = useRef<CleanupRequest | null>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CleanupDestination | null>(null);
  const [navigationFailed, setNavigationFailed] = useState(false);
  const navigationInFlight = useRef(false);
  const project = useProject(
    created ? scopeProjectRef(created.environmentId, created.projectId) : null,
  );
  const thread = useThreadShell(
    created ? scopeThreadRef(created.environmentId, created.threadId) : null,
  );
  const destination = created && project && thread ? created : null;
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const supported = environment?.serverConfig?.storageCleanupThreads === true;
  const start = useAtomCommand(serverEnvironment.startStorageCleanup, { reportFailure: false });
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (inFlight.current || !connected || !supported) return;
    if (created) {
      setError(null);
      setNavigationFailed(false);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    request.current ??= {
      environmentId,
      input: { threadId: newThreadId(), messageId: newMessageId(), commandId: newCommandId() },
    };
    try {
      const result = await start(request.current);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      setCreated({ environmentId: request.current.environmentId, ...result.value });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the cleanup thread.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  // The RPC receipt can beat the shell stream. Navigating before both records
  // arrive makes the thread route redirect to the unrelated new-draft landing.
  // Keep this watcher outside the popup so dismissing it cannot lose the handoff.
  useEffect(() => {
    if (!destination || navigationFailed || navigationInFlight.current) return;
    navigationInFlight.current = true;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: destination.environmentId, threadId: destination.threadId },
    })
      .then(() => {
        setOpen(false);
        setCreated(null);
        request.current = null;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to open the cleanup thread.");
        setNavigationFailed(true);
      })
      .finally(() => {
        navigationInFlight.current = false;
      });
  }, [destination, navigate, navigationFailed]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Storage: ${describeStorage(storage)}. Free up storage space`}
        className={cn(
          "inline-flex min-h-8 items-center gap-1 rounded-md px-1 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <HardDriveIcon className="size-3.5" aria-hidden />
        {formatStorageBytes(storage.freeBytes)}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="text-sm">Free up storage space</PopoverTitle>
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          {describeStorage(storage)}
        </p>
        <PopoverDescription className="mt-3 text-sm">
          {STORAGE_CLEANUP_DESCRIPTION}
        </PopoverDescription>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {!connected
              ? "Connect to this machine to start cleanup."
              : !supported
                ? "Update Solla Code on this machine to start a dedicated cleanup thread."
                : `Dedicated workspace on ${environment?.label ?? "this machine"}`}
          </p>
          {created && !navigationFailed ? (
            <p role="status" className="text-xs text-muted-foreground">
              {connected
                ? "Your cleanup thread was created. Opening it…"
                : "Your cleanup thread was created. Waiting to reconnect…"}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={
              pending || (created !== null && !navigationFailed) || !connected || !supported
            }
            onClick={() => void create()}
          >
            {pending
              ? "Creating thread…"
              : created
                ? navigationFailed
                  ? "Open cleanup thread"
                  : "Opening thread…"
                : "Create cleanup thread"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
