"use client";

import type { PreviewDownloadApproval } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";

import { Button } from "../ui/button";

export type PreviewDownloadApprovalDecision = "allow-domain" | "allow-once" | "deny";

export function answerPreviewDownloadApproval(
  id: string,
  decision: PreviewDownloadApprovalDecision,
): void {
  void window.desktopBridge?.preview
    ?.answerPreviewDownloadApproval(id, decision)
    .catch((error: unknown) => {
      console.error("Could not answer the download request.", error);
    });
}

export function previewDownloadApprovalSource(approval: PreviewDownloadApproval): string {
  return approval.domain.length > 0 ? approval.domain : "This page";
}

/** Allow / Deny controls shared by the browser overlay and the composer banner. */
export function PreviewDownloadApprovalActions(props: {
  readonly approval: PreviewDownloadApproval;
  readonly size?: "xs" | "sm";
}) {
  const size = props.size ?? "sm";
  const compact = size === "sm";
  return (
    <>
      <Button
        size={size}
        variant="ghost"
        className={compact ? "h-7 px-2 text-xs" : undefined}
        onClick={() => answerPreviewDownloadApproval(props.approval.id, "deny")}
      >
        Deny
      </Button>
      <Button
        size={size}
        variant="outline"
        className={compact ? "h-7 px-2 text-xs" : undefined}
        onClick={() => answerPreviewDownloadApproval(props.approval.id, "allow-once")}
      >
        Allow once
      </Button>
      <Button
        size={size}
        className={compact ? "h-7 px-2 text-xs" : undefined}
        disabled={props.approval.domain.length === 0}
        onClick={() => answerPreviewDownloadApproval(props.approval.id, "allow-domain")}
      >
        Allow for this domain
      </Button>
    </>
  );
}

/**
 * Asks before a site writes a file into the user's workspace.
 *
 * Downloads no longer raise the system save panel, which is what made agent
 * downloads work at all — but it also removed the only moment a human got to
 * say no. This is that moment, kept in the browser pane where the download is
 * happening: allow the site from now on, allow this one file, or refuse. The
 * bytes stream into a staging folder meanwhile, so "Allow" is instant and
 * "Deny" leaves nothing behind.
 */
export function PreviewDownloadApprovalPrompt(props: {
  /** Absent when the desktop host predates download approvals. */
  readonly approvals: ReadonlyArray<PreviewDownloadApproval> | undefined;
}) {
  const pending = props.approvals ?? [];
  if (pending.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex flex-col items-center gap-2 p-3"
      data-preview-download-approval="true"
    >
      {pending.slice(0, 3).map((approval) => (
        <div
          key={approval.id}
          className="pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-lg border border-warning/40 bg-background/95 px-3 py-2.5 shadow-lg backdrop-blur"
        >
          <div className="flex min-w-0 items-start gap-2">
            <DownloadIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {/* The domain leads: it is the thing being trusted, and the
                    thing an "Allow for this domain" answer is about. */}
                {previewDownloadApprovalSource(approval)} wants to download a file
              </p>
              <p className="truncate text-[11px] text-muted-foreground">{approval.fileName}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <PreviewDownloadApprovalActions approval={approval} />
          </div>
        </div>
      ))}
    </div>
  );
}
