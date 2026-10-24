import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { PreviewDownloadNotice, PreviewDownloadNoticeList } from "./PreviewDownloadNotice";
import {
  previewDownloadNoticeKey,
  usePreviewDownloadNoticeStore,
  visiblePreviewDownloads,
} from "./previewDownloadNotices";

const download = (name: string, completedAt = "2026-10-14T21:38:29.000Z") => ({
  fileName: name,
  path: `/Users/me/downloads/${name}`,
  completedAt,
  succeeded: true,
});

describe("PreviewDownloadNotice", () => {
  beforeEach(() => {
    usePreviewDownloadNoticeStore.setState({ dismissed: [] });
  });

  it("keeps a dismissed notice gone when the card mounts again", () => {
    const first = download("logs-1.txt");
    const second = download("logs-2.txt");
    usePreviewDownloadNoticeStore.getState().dismiss([previewDownloadNoticeKey(first)]);

    // A fresh render from the store stands in for the remount a tab or chat switch causes.
    const markup = renderToStaticMarkup(
      <PreviewDownloadNoticeList
        downloads={[first, second]}
        dismissed={usePreviewDownloadNoticeStore.getState().dismissed}
        onDismiss={() => {}}
      />,
    );
    expect(markup).not.toContain("logs-1.txt");
    expect(markup).toContain("logs-2.txt");
  });

  it("shows the same file again when it is downloaded again", () => {
    const earlier = download("logs.txt");
    usePreviewDownloadNoticeStore.getState().dismiss([previewDownloadNoticeKey(earlier)]);

    const again = download("logs.txt", "2026-10-14T22:00:00.000Z");
    const visible = visiblePreviewDownloads(
      [again, earlier],
      usePreviewDownloadNoticeStore.getState().dismissed,
    );
    expect(visible).toEqual([again]);
  });

  it("offers Clear all only when there is more than one notice", () => {
    const one = renderToStaticMarkup(<PreviewDownloadNotice downloads={[download("a.txt")]} />);
    expect(one).not.toContain("Clear all");

    const many = renderToStaticMarkup(
      <PreviewDownloadNotice downloads={[download("a.txt"), download("b.txt")]} />,
    );
    expect(many).toContain("Clear all");
  });

  it("clears every notice at once, including ones not yet on screen", () => {
    const downloads = ["a", "b", "c", "d", "e"].map((name) => download(`${name}.txt`));
    usePreviewDownloadNoticeStore.getState().dismiss(downloads.map(previewDownloadNoticeKey));

    expect(
      renderToStaticMarkup(
        <PreviewDownloadNoticeList
          downloads={downloads}
          dismissed={usePreviewDownloadNoticeStore.getState().dismissed}
          onDismiss={() => {}}
        />,
      ),
    ).toBe("");
  });
});
