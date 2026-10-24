"use client";

import type { PreviewDownload } from "@t3tools/contracts";
import { FolderOpenIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  previewDownloadNoticeKey,
  usePreviewDownloadNoticeStore,
  visiblePreviewDownloads,
} from "./previewDownloadNotices";

/**
 * Tells the user a file arrived, on the tab that fetched it.
 *
 * Downloads used to raise the system save panel, and that panel was the only
 * confirmation anything had happened. Suppressing it made downloads silent:
 * the user read "the button does nothing", and an agent with no confirmation
 * re-fetched the same 28 MB video eight times. This is the replacement — it
 * names the file, opens its folder, and can be dismissed one at a time or all
 * at once. Dismissals live in a store, not here: this card remounts on every
 * tab or chat switch.
 */
export function PreviewDownloadNotice(props: {
  /** Absent when the desktop host predates download reporting. */
  readonly downloads: ReadonlyArray<PreviewDownload> | undefined;
}) {
  const dismissed = usePreviewDownloadNoticeStore((state) => state.dismissed);
  const dismiss = usePreviewDownloadNoticeStore((state) => state.dismiss);
  return (
    <PreviewDownloadNoticeList
      downloads={props.downloads}
      dismissed={dismissed}
      onDismiss={dismiss}
    />
  );
}

export function PreviewDownloadNoticeList(props: {
  readonly downloads: ReadonlyArray<PreviewDownload> | undefined;
  readonly dismissed: ReadonlyArray<string>;
  readonly onDismiss: (keys: ReadonlyArray<string>) => void;
}) {
  const dismiss = props.onDismiss;
  // A renderer can outrun the desktop it is talking to, and a persisted
  // overlay can predate this field, so an absent list means "nothing to show"
  // rather than a crash that takes the whole preview panel down.
  const visible = visiblePreviewDownloads(props.downloads, props.dismissed);
  if (visible.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-3"
      data-preview-download-notice="true"
    >
      {visible.length > 1 ? (
        <div className="flex w-full max-w-md justify-end">
          <Button
            size="sm"
            variant="outline"
            className="pointer-events-auto h-6 bg-background/95 px-2 text-[11px] shadow-sm"
            onClick={() => dismiss(visible.map(previewDownloadNoticeKey))}
          >
            Clear all
          </Button>
        </div>
      ) : null}
      {visible.slice(0, 3).map((download) => (
        <div
          key={previewDownloadNoticeKey(download)}
          className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2 shadow-lg backdrop-blur"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {download.succeeded ? "Downloaded" : "Download failed"} · {download.fileName}
            </p>
            {/* The folder, not the full path: the file name is already above,
                and the thing the user cannot otherwise discover is where it went. */}
            <p className="truncate text-[11px] text-muted-foreground">
              {download.path.slice(0, download.path.length - download.fileName.length - 1)}
            </p>
          </div>
          {download.succeeded ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={() => {
                void window.desktopBridge?.preview
                  ?.revealPreviewDownload(download.path)
                  .catch((error: unknown) => {
                    console.error("Could not reveal the download.", error);
                  });
              }}
            >
              <FolderOpenIcon className="size-3.5" aria-hidden />
              Show
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={`Dismiss ${download.fileName}`}
            onClick={() => dismiss([previewDownloadNoticeKey(download)])}
          >
            <XIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}
