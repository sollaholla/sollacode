import { useAtomValue } from "@effect/atom-react";
import {
  threadArtifactIconResource,
  type ThreadArtifactSelectionTarget,
} from "@t3tools/client-runtime/state/thread-artifacts";
import type { ScopedThreadRef, ThreadArtifactSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { PackageIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useAssetUrl } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { threadArtifactEnvironment } from "~/state/threadArtifacts";
import { MenuItem } from "~/components/ui/menu";

function EnvironmentArtifactIcon(props: {
  readonly threadRef: ScopedThreadRef;
  readonly summary: ThreadArtifactSummary;
}) {
  const iconUrl = useAssetUrl(
    props.threadRef.environmentId,
    threadArtifactIconResource(props.summary),
  );
  return iconUrl ? (
    <img className="size-5 shrink-0 rounded-sm" src={iconUrl} alt="" aria-hidden />
  ) : (
    <PackageIcon className="size-5 shrink-0" aria-hidden />
  );
}

export interface ThreadArtifactShelfProps {
  readonly threadRef: ScopedThreadRef;
  readonly activeArtifactId: string | null;
  readonly onOpen: (
    target: ThreadArtifactSelectionTarget & { readonly summary: ThreadArtifactSummary },
  ) => void;
}

function useArtifactList(threadRef: ScopedThreadRef) {
  const listAtom = useMemo(
    () =>
      threadArtifactEnvironment.list({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, includeArchived: true },
      }),
    [threadRef.environmentId, threadRef.threadId],
  );
  const result = useAtomValue(listAtom);
  return { result, list: Option.getOrNull(AsyncResult.value(result)) };
}

export function ThreadArtifactDeepLinkOpener(props: {
  readonly threadRef: ScopedThreadRef;
  readonly requestedArtifactId: string | null;
  readonly onOpen: ThreadArtifactShelfProps["onOpen"];
}) {
  const { list } = useArtifactList(props.threadRef);
  const { onOpen, requestedArtifactId, threadRef } = props;
  const openedKeyRef = useRef<string | null>(null);
  const key = requestedArtifactId
    ? `${threadRef.environmentId}:${threadRef.threadId}:${requestedArtifactId}`
    : null;

  useEffect(() => {
    if (!key) {
      openedKeyRef.current = null;
      return;
    }
    if (openedKeyRef.current === key) return;
    const summary = list?.artifacts.find(
      (entry) => entry.artifact.artifactId === requestedArtifactId,
    );
    if (!summary) return;
    openedKeyRef.current = key;
    onOpen({
      environmentId: threadRef.environmentId,
      artifactId: summary.artifact.artifactId,
      summary,
    });
  }, [key, list, onOpen, requestedArtifactId, threadRef.environmentId]);

  return null;
}

export function ThreadArtifactMenu(props: ThreadArtifactShelfProps) {
  const { result, list } = useArtifactList(props.threadRef);
  const artifacts = list?.artifacts ?? [];

  if (result._tag === "Failure") {
    return <MenuItem disabled>Artifacts unavailable</MenuItem>;
  }
  if (artifacts.length === 0 && result._tag === "Success") {
    return <MenuItem disabled>No artifacts yet</MenuItem>;
  }
  if (artifacts.length === 0) {
    return <MenuItem disabled>Loading artifacts…</MenuItem>;
  }

  return artifacts.map((summary) => {
    const artifact = summary.artifact;
    const archived = artifact.archivedAt !== null;
    const active = props.activeArtifactId === artifact.artifactId;
    return (
      <MenuItem
        key={artifact.artifactId}
        className={cn("h-auto min-w-0 py-2", active && "bg-accent", archived && "opacity-65")}
        aria-current={active ? "page" : undefined}
        onClick={() =>
          props.onOpen({
            environmentId: props.threadRef.environmentId,
            artifactId: artifact.artifactId,
            summary,
          })
        }
      >
        <EnvironmentArtifactIcon threadRef={props.threadRef} summary={summary} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{artifact.title}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {archived ? "Archived" : artifact.kind} · revision {artifact.currentRevision}
          </span>
        </span>
      </MenuItem>
    );
  });
}
