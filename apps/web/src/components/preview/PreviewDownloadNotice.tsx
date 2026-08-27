"use client";

import type { PreviewDownload } from "@t3tools/contracts";
import { FolderOpenIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";

/**
 * Tells the user a file arrived, on the tab that fetched it.
 *
 * Downloads used to raise the system save panel, and that panel was the only
 * confirmation anything had happened. Suppressing it made downloads silent:
 * the user read "the button does nothing", and an agent with no confirmation
 * re-fetched the same 28 MB video eight times. This is the replacement — it
 * names the file, opens its folder, and can be dismissed.
 */
export function PreviewDownloadNotice(props: {
  /** Absent when the desktop host predates download reporting. */
  readonly downloads: ReadonlyArray<PreviewDownload> | undefined;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // A renderer can outrun the desktop it is talking to, and a persisted
  // overlay can predate this field, so an absent list means "nothing to show"
  // rather than a crash that takes the whole preview panel down.
  const visible = (props.downloads ?? []).filter((download) => !dismissed.has(download.path));
  if (visible.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-3"
      data-preview-download-notice="true"
    >
      {visible.slice(0, 3).map((download) => (
        <div
          key={download.path}
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
            onClick={() => setDismissed((current) => new Set(current).add(download.path))}
          >
            <XIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}
