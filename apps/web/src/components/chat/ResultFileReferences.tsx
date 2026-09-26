import { EventId, MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import type { TurnFileReference } from "@t3tools/client-runtime/state/turn-file-references";
import { FileImageIcon, FilmIcon, AudioLinesIcon, XIcon, ExternalLinkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { createHostPathExistenceStore, useHostPathExistence } from "../../hostPathExistence";
import { filesystemEnvironment } from "../../state/filesystem";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAssetUrlState } from "../../assets/assetUrls";
import ChatMarkdown from "../ChatMarkdown";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "../ui/dialog";

// Results can refer to files created or removed during the same session. Share
// short-lived, batched answers across cards without persisting yesterday's files.
const referencePathStore = createHostPathExistenceStore({ storage: null, ttlMs: 30_000 });

export function ResultFileReferences(props: {
  references: ReadonlyArray<TurnFileReference>;
  threadRef: ScopedThreadRef | null;
  cwd?: string | undefined;
  standalone?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<TurnFileReference | null>(null);
  const paths = useMemo(
    () =>
      props.references
        .map((reference) => reference.path)
        .filter((path) => /^(?:\/|[a-z]:[\\/])/iu.test(path)),
    [props.references],
  );
  const probeHostPaths = useAtomCommand(filesystemEnvironment.pathsExistNow, {
    reportFailure: false,
  });
  const pathKinds = useHostPathExistence(
    props.threadRef?.environmentId ?? null,
    paths,
    true,
    probeHostPaths,
    referencePathStore,
  );
  const references = props.references.filter(
    (reference) => pathKinds.get(reference.path) === "file",
  );
  if (!references.length) return null;
  const visible = expanded ? references : references.slice(0, 6);
  return (
    <section
      className={
        props.standalone ? "mt-3 rounded-[10px] border border-[var(--line)] px-4 py-4" : "px-2 py-2"
      }
      data-result-summary={props.standalone ? "references" : undefined}
      aria-label="Referenced files"
    >
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">
        Referenced files · {references.length}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.map((reference) => {
          const Icon =
            reference.kind === "image"
              ? FileImageIcon
              : reference.kind === "video"
                ? FilmIcon
                : AudioLinesIcon;
          return reference.kind === "image" ||
            reference.kind === "video" ||
            reference.kind === "audio" ? (
            <button
              key={reference.path}
              type="button"
              title={reference.path}
              aria-label={`Preview ${reference.name}`}
              onClick={() => setSelected(reference)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-transparent px-2 py-1.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="max-w-56 truncate">{reference.name}</span>
            </button>
          ) : (
            <div key={reference.path} className="min-w-0 max-w-full text-xs">
              <ChatMarkdown
                text={`[${reference.name.replace(/[\u005b\u005d]/gu, "")}](<${reference.path.replaceAll(">", "%3E")}>)`}
                cwd={props.cwd}
                threadRef={props.threadRef ?? undefined}
                {...(reference.sourceMessageId
                  ? { sourceMessageId: MessageId.make(reference.sourceMessageId) }
                  : {})}
              />
            </div>
          );
        })}
        {references.length > 6 && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show fewer references" : `Show all ${references.length} references`}
          </button>
        )}
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <DialogContent
            bottomStickOnMobile={false}
            showCloseButton={false}
            className="flex w-full flex-col overflow-hidden p-0 max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0 sm:h-[min(85dvh,800px)] sm:max-w-4xl"
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5 sm:pt-3">
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {selected.kind} preview
                </p>
                <DialogTitle className="truncate text-sm leading-5" title={selected.name}>
                  {selected.name}
                </DialogTitle>
              </div>
              <DialogClose
                aria-label="Close preview"
                className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-accent"
              >
                <XIcon className="size-5" />
              </DialogClose>
            </header>
            {props.threadRef ? (
              <LocalMediaContents reference={selected} threadRef={props.threadRef} />
            ) : (
              <p className="py-4 text-sm">Connect to the file’s environment to preview it.</p>
            )}
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
function LocalMediaContents({
  reference,
  threadRef,
}: {
  reference: TurnFileReference;
  threadRef: ScopedThreadRef;
}) {
  const resource = useMemo(
    () => ({
      _tag: "workspace-file" as const,
      threadId: threadRef.threadId,
      path: reference.path,
      ...(reference.sourceMessageId
        ? { sourceMessageId: MessageId.make(reference.sourceMessageId) }
        : {}),
      ...(reference.sourceActivityId
        ? { sourceActivityId: EventId.make(reference.sourceActivityId) }
        : {}),
    }),
    [reference, threadRef.threadId],
  );
  const asset = useAssetUrlState(threadRef.environmentId, resource);
  if (asset._tag === "Failure")
    return (
      <p role="alert" className="py-4 text-sm">
        This file could not be previewed. It may have moved or the environment may be offline.
      </p>
    );
  if (asset._tag !== "Success")
    return (
      <p role="status" className="py-4 text-sm">
        Loading preview…
      </p>
    );
  return <MediaContents reference={reference} url={asset.url} />;
}
function MediaContents({ reference, url }: { reference: TurnFileReference; url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/5 p-3 dark:bg-black/30 sm:p-5">
        {failed ? (
          <p role="alert" className="py-3 text-sm">
            This browser cannot display this media.
          </p>
        ) : reference.kind === "image" ? (
          <img
            src={url}
            alt={reference.name}
            className="h-full max-h-full w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : reference.kind === "video" ? (
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            className="max-h-full w-full rounded-lg"
            onError={() => setFailed(true)}
          />
        ) : (
          <audio
            src={url}
            controls
            preload="metadata"
            className="w-full"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <footer className="flex shrink-0 justify-end border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
        >
          <ExternalLinkIcon className="size-4" aria-hidden /> Open original
        </a>
      </footer>
    </div>
  );
}
