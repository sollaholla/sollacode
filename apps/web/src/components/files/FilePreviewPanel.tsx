import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspaceVideoPreviewPath,
  workspaceAudioMimeType,
  workspaceVideoMimeType,
} from "@t3tools/shared/filePreview";
import { VirtualizedFile, type SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronRight,
  Code2,
  ExternalLink as ExternalLinkIcon,
  Eye,
  File as FileIcon,
  Folder as FolderIcon,
  FolderTree,
  Globe2,
  Link as LinkIcon,
  LoaderCircle,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { resolvePathLinkTarget } from "~/terminal-links";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";
import { projectFileCacheKey, projectFileEditorCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectEntriesQuery,
  useProjectFileQuery,
} from "./projectFilesQueryState";
import { directChildEntries, entryName, parentFolderPath } from "./folderEntries";
import { ZoomableImage } from "../chat/ZoomableImage";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";
const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly alt: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load workspace image.
      </div>
    );
  }

  return assetUrl._tag === "Success" ? (
    <ZoomableImage
      key={assetUrl.url}
      src={assetUrl.url}
      alt={props.alt}
      className="max-h-full max-w-full object-contain"
      surfaceClassName="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      onError={() => setFailedUrl(assetUrl.url)}
    />
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

/**
 * Hand a file to the system's default application.
 *
 * Only the desktop build can do this - a browser tab has no way to launch
 * another program - so the caller is responsible for offering it only where
 * `window.desktopBridge` exists. Reports the OS's own reason on failure rather
 * than a generic apology, because "no application is registered for .foo" and
 * "the file is gone" ask the user for different things.
 */
async function openPathInDefaultApp(absolutePath: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge?.openPath) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open file",
        description: "Opening files in another app needs the Solla Code desktop app.",
      }),
    );
    return;
  }
  try {
    const failure = await bridge.openPath(absolutePath);
    if (failure === "") return;
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Unable to open file", description: failure }),
    );
  } catch (cause) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open file",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      }),
    );
  }
}

/**
 * What the panel shows for a file it cannot render itself.
 *
 * The old behaviour was to open the panel and then say the format is not
 * supported, which spends a click to reach a dead end. The file's own
 * application can almost always open it, so that is offered as the action
 * instead of presented as an error.
 */
/**
 * A folder opened where a file was expected.
 *
 * Chat links point at folders as readily as files, and the file query answers
 * `path_not_file` for one. That used to end in "Unable to open file"; the
 * folder's contents are the answer the user actually wanted. Entries come
 * from the same listing the explorer uses, narrowed to one level, and each
 * row reopens the panel on that entry — so a folder row lists in turn.
 */
function WorkspaceFolderPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const entries = useProjectEntriesQuery(props.environmentId, props.cwd);
  const children = useMemo(
    () => directChildEntries(entries.data?.entries ?? [], props.relativePath),
    [entries.data, props.relativePath],
  );
  const parent = parentFolderPath(props.relativePath);
  if (entries.data === null && entries.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  if (entries.data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {entries.error ?? "Unable to list this folder."}
      </div>
    );
  }
  const rowClassName =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="workspace-folder-preview"
    >
      <ul className="divide-y divide-border/60">
        {parent !== null && parent.length > 0 ? (
          <li>
            <button type="button" className={rowClassName} onClick={() => props.onOpenFile(parent)}>
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono">..</span>
            </button>
          </li>
        ) : null}
        {children.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={rowClassName}
              onClick={() => props.onOpenFile(entry.path)}
            >
              {entry.kind === "directory" ? (
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate font-mono">
                {entryName(entry.path)}
                {entry.kind === "directory" ? "/" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {children.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          This folder has no listed files.
        </p>
      ) : null}
      {entries.data.truncated ? (
        <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">
          The workspace listing was cut short, so some entries may be missing.
        </p>
      ) : null}
    </div>
  );
}

function UnsupportedFilePreview(props: {
  readonly absolutePath: string | null;
  readonly relativePath: string;
  readonly reason: string;
}) {
  const canOpen = typeof window !== "undefined" && Boolean(window.desktopBridge?.openPath);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-xs leading-relaxed text-muted-foreground">{props.reason}</p>
      {canOpen && props.absolutePath ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void openPathInDefaultApp(props.absolutePath as string);
          }}
        >
          Open in default app
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Hand the user the media's own URL, so it can be opened outside the panel.
 *
 * The asset URL is already absolute against the connection's base, so on a
 * device reached over Tailscale it is a tailnet URL, and its token is a signed
 * capability in the URL rather than a cookie - which means it travels. Copying
 * it, or opening it in a new tab, is what lets a phone hand a video to the
 * system player, AirDrop it, or keep watching after the panel is closed.
 */
function MediaLinkActions(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  if (assetUrl._tag !== "Success") return null;
  const url = assetUrl.url;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Copy media link"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(
                  () =>
                    toastManager.add(
                      stackedThreadToast({ type: "success", title: "Media link copied" }),
                    ),
                  () =>
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Unable to copy the media link",
                      }),
                    ),
                );
              }}
            >
              <LinkIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Copy a link that opens this on any device</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open media in a new tab"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Open outside the panel</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly relativePath: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [undecodable, setUndecodable] = useState(false);
  const mimeType = workspaceVideoMimeType(props.relativePath);

  if (assetUrl._tag === "Failure") {
    return (
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="Unable to load this video from the workspace."
      />
    );
  }

  // The container is previewable but its codec is not - a ProRes .mov, say.
  // Nothing in the browser can play it, so hand it to something that can
  // rather than leaving a black rectangle on screen.
  if (undecodable) {
    return (
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="This video uses a codec the preview cannot play."
      />
    );
  }

  return assetUrl._tag === "Success" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/80 p-4">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a workspace file has no track */}
      <video
        className="max-h-full max-w-full object-contain"
        controls
        playsInline
        preload="metadata"
        onError={() => setUndecodable(true)}
      >
        <source src={assetUrl.url} {...(mimeType ? { type: mimeType } : {})} />
      </video>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function WorkspaceAudioPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly relativePath: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [undecodable, setUndecodable] = useState(false);
  const mimeType = workspaceAudioMimeType(props.relativePath);
  const fileName = props.relativePath.split("/").at(-1) ?? props.relativePath;

  if (assetUrl._tag === "Failure") {
    return (
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="Unable to load this audio from the workspace."
      />
    );
  }

  if (undecodable) {
    return (
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="This audio uses a codec the preview cannot play."
      />
    );
  }

  return assetUrl._tag === "Success" ? (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4">
      <p className="max-w-full truncate text-sm text-muted-foreground" title={props.relativePath}>
        {fileName}
      </p>
      <audio
        className="w-full max-w-md"
        controls
        preload="metadata"
        onError={() => setUndecodable(true)}
      >
        <source src={assetUrl.url} {...(mimeType ? { type: mimeType } : {})} />
      </audio>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function WorkspacePdfPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly relativePath: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });

  if (assetUrl._tag === "Failure") {
    return (
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="Unable to load this PDF from the workspace."
      />
    );
  }

  // An <object> rather than an <iframe>: it renders through the same built-in
  // viewer, and its children are the documented fallback when no PDF plugin is
  // available, which is exactly where the open-in-app action belongs.
  return assetUrl._tag === "Success" ? (
    <object
      className="min-h-0 flex-1"
      data={assetUrl.url}
      type="application/pdf"
      aria-label={props.relativePath}
    >
      <UnsupportedFilePreview
        absolutePath={props.absolutePath}
        relativePath={props.relativePath}
        reason="This PDF cannot be displayed here."
      />
    </object>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const existingState = revealStatesByPath.get(relativePath);
      const state: FileRevealState = existingState ?? {
        frameId: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      };
      if (!existingState) revealStatesByPath.set(relativePath, state);

      const cancelPendingReveal = () => {
        if (state.frameId !== null) {
          cancelAnimationFrame(state.frameId);
          state.frameId = null;
        }
        state.cancelGuard?.();
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const contents = instance.file?.contents;
      const targetLine =
        revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (state.latestRequestId !== revealRequestId) {
        cancelPendingReveal();
        state.latestRequestId = revealRequestId;
        state.handledRequestId = null;
      }

      if (revealLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (state.handledRequestId === revealRequestId || state.frameId !== null) {
        return;
      }

      const resolveScrollTarget = (line: number): number | null => {
        const linePosition = instance.getLinePosition(line);
        if (!linePosition) return null;

        const scrollContainerRect = scrollContainer.getBoundingClientRect();
        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainerRect.top;
        const root = fileContainer.shadowRoot ?? fileContainer;
        const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
        const renderedLineRect = renderedLineElement?.getBoundingClientRect();

        return resolveCenteredFileLineScrollTop({
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
          viewportTop: scrollContainerRect.top,
          viewportHeight: scrollContainer.clientHeight,
          fileTop,
          estimatedLine: linePosition,
          ...(renderedLineRect && renderedLineRect.height > 0
            ? {
                renderedLine: {
                  top: renderedLineRect.top,
                  height: renderedLineRect.height,
                },
              }
            : {}),
        });
      };

      const guardScrollTarget = (line: number) => {
        let framesLeft = REVEAL_GUARD_FRAMES;
        let guardFrameId: number | null = null;
        const cancelGuard = () => {
          if (guardFrameId !== null) {
            cancelAnimationFrame(guardFrameId);
            guardFrameId = null;
          }
          scrollContainer.removeEventListener("wheel", cancelGuard);
          scrollContainer.removeEventListener("touchstart", cancelGuard);
          scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
          window.removeEventListener("keydown", cancelGuard, true);
          if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
        };
        scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
        scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a comment cancels the reveal guard before the row expands.
        scrollContainer.addEventListener("pointerdown", cancelGuard, {
          passive: true,
          capture: true,
        });
        window.addEventListener("keydown", cancelGuard, true);
        const holdTarget = () => {
          guardFrameId = null;
          framesLeft -= 1;
          if (framesLeft <= 0 || !scrollContainer.isConnected) {
            cancelGuard();
            return;
          }
          const targetTop = resolveScrollTarget(line);
          if (
            targetTop !== null &&
            Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
          ) {
            scrollContainer.scrollTop = targetTop;
          }
          guardFrameId = requestAnimationFrame(holdTarget);
        };
        guardFrameId = requestAnimationFrame(holdTarget);
        state.cancelGuard = cancelGuard;
      };

      const scheduleReveal = (attempt: number) => {
        state.frameId = requestAnimationFrame(() => {
          state.frameId = null;
          if (state.latestRequestId !== revealRequestId || !fileContainer.isConnected) {
            return;
          }

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
          const currentContents = instance.file?.contents;
          const line =
            currentContents === undefined ? null : clampFileLine(currentContents, revealLine);
          const targetTop = line === null ? null : resolveScrollTarget(line);
          if (line === null || targetTop === null) {
            if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
            return;
          }
          updateFileLinkReveal(fileContainer, line);

          scrollContainer.scrollTop = targetTop;
          state.handledRequestId = revealRequestId;
          guardScrollTarget(line);
        });
      };

      scheduleReveal(0);
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId],
  );
}

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: Pick<
  EditableFileSurfaceProps,
  "environmentId" | "cwd" | "relativePath" | "onPendingChange"
>): FileSaveCoordinator {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: (nextContents) =>
          writeFile({
            environmentId,
            input: { cwd, relativePath, contents: nextContents },
          }),
        onConfirmed: (confirmedContents) => {
          confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
        },
      }),
    [cwd, environmentId, onPendingChange, relativePath, writeFile],
  );

  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}

function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onPendingChange,
}: EditableFileSurfaceProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });
  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        persistState: true,
        persistStateStorage: "inMemory",
        onChange: (file, nextLineAnnotations) => {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
          saveCoordinator.change(file.contents);
          if (nextLineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            setLineAnnotations(remapped);
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
                addReviewComment(
                  composerDraftTarget,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: file.contents,
                  }),
                );
              }
            }
          }
        },
      }),
    [addReviewComment, composerDraftTarget, cwd, environmentId, relativePath, saveCoordinator],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      );
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      );
    });
  }, []);
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) {
        beginComment(range);
      }
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

  return (
    <EditProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: relativePath,
              contents,
              cacheKey: projectFileEditorCacheKey(
                environmentId,
                cwd,
                relativePath,
                contents,
                editor.getFile(),
              ),
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <LocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  onPendingChange,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
> & {
  threadRef: ScopedThreadRef;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ChatMarkdown
        text={contents}
        cwd={cwd}
        threadRef={threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) => {
          const currentContents =
            getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
            contents;
          const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
          if (nextContents === currentContents) return;
          setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
          saveCoordinator.change(nextContents);
        }}
      />
    </ScrollArea>
  );
}

/**
 * Collapsed by default.
 *
 * The right panel is a split, and the explorer took a large share of it before
 * the user had asked for any file — leaving little room for the file actually
 * being viewed. An explicit stored preference still wins, so opening it once
 * keeps it open; only the unset default changed.
 */
function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? false;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  onOpenFile,
  onPendingChange,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isImage = relativePath !== null && isWorkspaceImagePreviewPath(relativePath);
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && isWorkspaceAudioPreviewPath(relativePath);
  const isPdf = relativePath !== null && isWorkspacePdfPreviewPath(relativePath);
  // Media is fetched as an asset URL, never as text. Reading a video through
  // the file query would pull the whole thing into memory as a string before
  // anything could play.
  const isMedia = isImage || isVideo || isAudio || isPdf;
  const file = useProjectFileQuery(environmentId, cwd, relativePath, !isMedia);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  // Reading markdown rendered is a preference, not a property of one file. Keeping
  // it on the panel meant a thread switch dropped it and forced source back.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  // Paired with the path on purpose: each file surface counts its reveals from
  // one, so a bare id would let a dismissed reveal on one file swallow the first
  // reveal on the next.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  // A reveal still wins over the preference: the line only exists in the source.
  const renderMarkdown =
    isMarkdown &&
    renderMarkdownPreferred &&
    (revealLine === null ||
      (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId));
  const canOpenInBrowser =
    relativePath !== null && isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath);
  const absolutePath = relativePath ? resolvePathLinkTarget(relativePath, cwd) : null;
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="surface-subheader gap-2 px-3" data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      "max-w-40 truncate",
                      crumb.kind === "file"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath && environmentId === primaryEnvironmentId ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {isMarkdown ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={renderMarkdown}
                    onPressedChange={(pressed) => {
                      setRenderMarkdownPreferred(pressed);
                      setHandledReveal(
                        pressed && relativePath !== null
                          ? { path: relativePath, requestId: revealRequestId }
                          : null,
                      );
                    }}
                    aria-label={renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
                    variant="ghost"
                    size="sm"
                  >
                    {renderMarkdown ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Toggle>
                }
              />
              <TooltipPopup>
                {renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {isMedia && absolutePath ? (
            <MediaLinkActions
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
            />
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              alt={relativePath}
            />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              relativePath={relativePath}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              relativePath={relativePath}
            />
          ) : relativePath && isPdf && absolutePath ? (
            <WorkspacePdfPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              relativePath={relativePath}
            />
          ) : relativePath && file.failure === "path_not_file" && file.data === null ? (
            <WorkspaceFolderPreview
              key={relativePath}
              environmentId={environmentId}
              cwd={cwd}
              relativePath={relativePath}
              onOpenFile={onOpenFile}
            />
          ) : relativePath && file.error && file.data === null ? (
            // A file the text view cannot decode is not an error to report, it
            // is a file that belongs to another application. Offer that instead
            // of ending on a message the user can do nothing with.
            <UnsupportedFilePreview
              absolutePath={absolutePath}
              relativePath={relativePath}
              reason={file.error}
            />
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                onPendingChange={onPendingChange}
              />
            ) : file.data.truncated ? (
              <Virtualizer
                key={`${relativePath}:${resolvedTheme}:${file.data.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
                onPendingChange={onPendingChange}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
