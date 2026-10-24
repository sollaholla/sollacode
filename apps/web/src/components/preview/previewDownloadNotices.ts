import type { PreviewDownload } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** Enough to cover every notice a desktop still lists, which keeps 5 per tab. */
const DISMISSED_NOTICE_LIMIT = 200;

/**
 * One finished download. The finish time is part of it, so fetching the same
 * file again raises a fresh notice instead of staying dismissed.
 */
export function previewDownloadNoticeKey(download: PreviewDownload): string {
  return `${download.completedAt}|${download.path}`;
}

export function visiblePreviewDownloads(
  downloads: ReadonlyArray<PreviewDownload> | undefined,
  dismissed: ReadonlyArray<string>,
): ReadonlyArray<PreviewDownload> {
  if (!downloads || downloads.length === 0) return [];
  const hidden = new Set(dismissed);
  return downloads.filter((download) => !hidden.has(previewDownloadNoticeKey(download)));
}

interface PreviewDownloadNoticeState {
  /** Newest first. */
  readonly dismissed: ReadonlyArray<string>;
  readonly dismiss: (keys: ReadonlyArray<string>) => void;
}

/**
 * Download notices the user dismissed. They lived in the card's own state, and
 * the card remounts whenever the user switches tabs or chats while the desktop
 * still lists the download, so every dismissed card came back. Persisted so a
 * reload does not bring them back either.
 */
export const usePreviewDownloadNoticeStore = create<PreviewDownloadNoticeState>()(
  persist(
    (set) => ({
      dismissed: [],
      dismiss: (keys) =>
        set((state) => {
          const added = keys.filter((key) => !state.dismissed.includes(key));
          if (added.length === 0) return state;
          return { dismissed: [...added, ...state.dismissed].slice(0, DISMISSED_NOTICE_LIMIT) };
        }),
    }),
    {
      name: "t3code:preview-download-notices:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ dismissed: state.dismissed }),
    },
  ),
);
