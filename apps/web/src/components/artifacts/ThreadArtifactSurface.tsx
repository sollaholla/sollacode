import { threadArtifactIconResource } from "@t3tools/client-runtime/state/thread-artifacts";
import {
  ThreadArtifactId,
  type AssetResource,
  type ScopedThreadRef,
  type ThreadArtifactDetail,
  type ThreadArtifactKind,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PackageIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import ChatMarkdown from "~/components/ChatMarkdown";

import { useAssetUrl, useAssetUrlState } from "~/assets/assetUrls";
import type { RightPanelSurface } from "~/rightPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { threadArtifactEnvironment } from "~/state/threadArtifacts";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { buildThreadRouteParams } from "~/threadRoutes";

type ArtifactSurface = Extract<RightPanelSurface, { kind: "artifact" }>;

export function ArtifactDeepLinkButton(props: { readonly onNavigate: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={props.onNavigate}
    >
      Link
    </button>
  );
}

export function artifactFrameSandbox(kind: ThreadArtifactKind): string {
  return kind === "web" ? "allow-scripts" : "";
}

export function resolveArtifactContentResource(input: {
  readonly threadId: ScopedThreadRef["threadId"];
  readonly artifactId: ThreadArtifactId;
  readonly displayedRevision: number;
  readonly summary: Pick<ThreadArtifactSummary, "entryResource" | "revision"> | null;
  readonly detail: Pick<ThreadArtifactDetail, "entryResource" | "revisions"> | null;
}): AssetResource | null {
  if (input.summary?.entryResource.revision === input.displayedRevision) {
    return input.summary.entryResource;
  }
  if (input.detail?.entryResource.revision === input.displayedRevision) {
    return input.detail.entryResource;
  }
  const revision =
    input.detail?.revisions.find((entry) => entry.revision === input.displayedRevision) ??
    (input.summary?.revision.revision === input.displayedRevision ? input.summary.revision : null);
  return revision
    ? {
        _tag: "artifact-revision",
        threadId: input.threadId,
        artifactId: input.artifactId,
        revision: input.displayedRevision,
        path: revision.entryPath,
      }
    : null;
}

function errorMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const failure = Cause.squash(cause);
  return failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
}

function ArtifactPreview(props: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly resource: AssetResource | null;
  readonly kind: ThreadArtifactKind;
  readonly title: string;
  readonly revisionKey: string;
}) {
  if (props.resource === null) {
    return (
      <div className="m-3 rounded-lg border p-3 text-sm text-muted-foreground">
        Loading artifact…
      </div>
    );
  }
  return <ResolvedArtifactPreview {...props} resource={props.resource} />;
}

function ResolvedArtifactPreview(props: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly resource: AssetResource;
  readonly kind: ThreadArtifactKind;
  readonly title: string;
  readonly revisionKey: string;
}) {
  const content = useAssetUrlState(props.environmentId, props.resource, "artifact");
  if (content._tag === "Failure") {
    return (
      <div className="m-3 rounded-lg border p-3 text-sm text-muted-foreground">
        The signed artifact URL could not be created. Refresh the connection and try again.
      </div>
    );
  }
  if (content._tag === "Loading") {
    return (
      <div className="m-3 rounded-lg border p-3 text-sm text-muted-foreground">
        Loading artifact…
      </div>
    );
  }
  if (props.kind === "image") {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
        <img
          src={content.url}
          alt={props.title}
          className="mx-auto block h-auto max-w-full rounded-lg object-contain"
        />
      </div>
    );
  }
  if (props.kind === "markdown") {
    return <MarkdownArtifactPreview key={props.revisionKey} url={content.url} />;
  }
  return (
    <iframe
      key={props.revisionKey}
      src={content.url}
      title={props.title}
      sandbox={artifactFrameSandbox(props.kind)}
      referrerPolicy="no-referrer"
      className="min-h-0 min-w-0 flex-1 border-0 bg-background"
    />
  );
}

type MarkdownArtifactState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly text: string }
  | { readonly _tag: "failed" };

/**
 * Markdown artifacts render as actual markdown — the same renderer chat
 * messages use — instead of an iframe showing the raw source. The bytes are
 * decoded as UTF-8 explicitly (artifact publishes are declared UTF-8), so a
 * stale response without a charset can't mojibake em dashes.
 */
function MarkdownArtifactPreview(props: { readonly url: string }) {
  const [state, setState] = useState<MarkdownArtifactState>({ _tag: "loading" });

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setState({ _tag: "loading" });
    void fetch(props.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Artifact fetch failed with HTTP ${response.status}.`);
        return new TextDecoder("utf-8").decode(await response.arrayBuffer());
      })
      .then((text) => {
        if (!disposed) setState({ _tag: "ready", text });
      })
      .catch(() => {
        if (!disposed) setState({ _tag: "failed" });
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [props.url]);

  if (state._tag === "loading") {
    return (
      <div className="m-3 rounded-lg border p-3 text-sm text-muted-foreground">
        Loading artifact…
      </div>
    );
  }
  if (state._tag === "failed") {
    return (
      <div className="m-3 rounded-lg border p-3 text-sm text-muted-foreground">
        The artifact content could not be loaded. Refresh the connection and try again.
      </div>
    );
  }
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        <ChatMarkdown text={state.text} cwd={undefined} />
      </div>
    </div>
  );
}

export function ThreadArtifactSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: ArtifactSurface;
}) {
  const navigate = useNavigate();
  const artifactId = ThreadArtifactId.make(props.surface.resourceId);
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const listAtom = useMemo(
    () =>
      threadArtifactEnvironment.list({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, includeArchived: true },
      }),
    [props.threadRef.environmentId, props.threadRef.threadId],
  );
  const detailAtom = useMemo(
    () =>
      threadArtifactEnvironment.detail({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, artifactId },
      }),
    [artifactId, props.threadRef.environmentId, props.threadRef.threadId],
  );
  const listQuery = useEnvironmentQuery(listAtom);
  const detailQuery = useEnvironmentQuery(detailAtom);
  const summary = listQuery.data?.artifacts.find(
    (entry) => entry.artifact.artifactId === artifactId,
  );
  // The subscription is authoritative for current metadata. Detail may be an
  // older cached revision while a publish snapshot is already on screen.
  const artifact = summary?.artifact ?? detailQuery.data?.artifact ?? null;
  const revision =
    detailQuery.data?.revisions.find((entry) => entry.revision === props.surface.revision) ??
    (summary?.revision.revision === props.surface.revision ? summary.revision : null);
  const contentResource = useMemo<AssetResource | null>(
    () =>
      resolveArtifactContentResource({
        threadId: props.threadRef.threadId,
        artifactId,
        displayedRevision: props.surface.revision,
        summary: summary ?? null,
        detail: detailQuery.data ?? null,
      }),
    [artifactId, detailQuery.data, props.surface.revision, props.threadRef.threadId, summary],
  );
  const iconUrl = useAssetUrl(
    props.threadRef.environmentId,
    summary?.iconResource.revision === props.surface.revision
      ? threadArtifactIconResource(summary)
      : detailQuery.data?.iconResource.revision === props.surface.revision
        ? detailQuery.data.iconResource
        : {
            _tag: "artifact-icon",
            threadId: props.threadRef.threadId,
            artifactId,
            revision: props.surface.revision,
          },
  );
  const archive = useAtomCommand(threadArtifactEnvironment.archive, { reportFailure: false });
  const restore = useAtomCommand(threadArtifactEnvironment.restore, { reportFailure: false });
  const deleteArtifact = useAtomCommand(threadArtifactEnvironment.delete, {
    reportFailure: false,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const latestRevision = artifact?.currentRevision ?? props.surface.revision;
  const updateAvailable = latestRevision > props.surface.revision;

  const mutateArchiveState = async () => {
    if (!artifact || mutating) return;
    setMutating(true);
    setMutationError(null);
    const command = artifact.archivedAt === null ? archive : restore;
    const result = await command({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, artifactId },
    });
    setMutating(false);
    if (result._tag === "Failure") {
      setMutationError(
        errorMessage(
          result.cause,
          artifact.archivedAt === null
            ? "The artifact could not be archived."
            : "The artifact could not be restored.",
        ),
      );
      return;
    }
    detailQuery.refresh();
  };

  const performDelete = async () => {
    if (mutating) return;
    setMutating(true);
    setMutationError(null);
    const result = await deleteArtifact({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, artifactId },
    });
    setMutating(false);
    setConfirmingDelete(false);
    if (result._tag === "Failure") {
      setMutationError(errorMessage(result.cause, "The artifact could not be deleted."));
      return;
    }
    // The artifact no longer exists, so the tab showing it goes with it.
    useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {updateAvailable && artifact ? (
        <div
          role="status"
          className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/70 bg-muted/35 px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 break-words">
            Revision {artifact.currentRevision} is available. You are viewing revision{" "}
            {props.surface.revision}.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() =>
              useRightPanelStore
                .getState()
                .updateArtifactRevision(
                  props.threadRef,
                  artifact.artifactId,
                  artifact.currentRevision,
                  artifact.title,
                )
            }
          >
            <RefreshCwIcon /> Use latest
          </Button>
        </div>
      ) : null}

      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        {iconUrl ? (
          <img src={iconUrl} alt="" aria-hidden className="size-7 shrink-0 rounded-md" />
        ) : (
          <PackageIcon className="size-7 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-36 flex-1">
          <h2 className="truncate text-sm font-medium">{artifact?.title ?? props.surface.title}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {artifact?.kind ?? "artifact"} · revision {props.surface.revision}
            {revision
              ? ` · ${revision.fileCount} ${revision.fileCount === 1 ? "file" : "files"}`
              : ""}
          </p>
        </div>
        {artifact?.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
        <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1 min-[520px]:flex-none">
          <ArtifactDeepLinkButton
            onNavigate={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(props.threadRef),
                search: { artifact: artifactId },
                replace: true,
              })
            }
          />
          {artifact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={mutating}
              onClick={() => void mutateArchiveState()}
            >
              {artifact.archivedAt === null ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
              {mutating ? "Saving…" : artifact.archivedAt === null ? "Archive" : "Restore"}
            </Button>
          ) : null}
          {artifact ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={mutating}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2Icon />
              Delete
            </Button>
          ) : null}
        </div>
      </header>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogPopup className="w-full max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete artifact</DialogTitle>
            <DialogDescription>
              “{artifact?.title ?? props.surface.title}” and every revision of it will be removed
              from this computer. Unlike archiving, this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={mutating}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={mutating}
              onClick={() => void performDelete()}
            >
              {mutating ? "Deleting…" : "Delete artifact"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {mutationError ? (
        <p
          role="alert"
          className="break-words border-b border-border/70 px-3 py-2 text-xs text-destructive"
        >
          {mutationError}
        </p>
      ) : null}
      {detailQuery.error || listQuery.error ? (
        <div className="m-3 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          This artifact is unavailable from the connected host.
        </div>
      ) : (
        <ArtifactPreview
          environmentId={props.threadRef.environmentId}
          resource={contentResource}
          kind={artifact?.kind ?? "structured"}
          title={artifact?.title ?? props.surface.title}
          revisionKey={`${artifactId}:${props.surface.revision}`}
        />
      )}
    </section>
  );
}
