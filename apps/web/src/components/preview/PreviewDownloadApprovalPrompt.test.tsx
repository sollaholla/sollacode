import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewDownloadApprovalActions,
  PreviewDownloadApprovalPrompt,
  previewDownloadApprovalSource,
} from "./PreviewDownloadApprovalPrompt";

const approval = {
  id: "download-approval-1",
  domain: "grok.com",
  fileName: "clip.mp4",
};

describe("PreviewDownloadApprovalPrompt", () => {
  it("names the domain that must be trusted", () => {
    expect(previewDownloadApprovalSource(approval)).toBe("grok.com");
    expect(previewDownloadApprovalSource({ ...approval, domain: "" })).toBe("This page");
  });

  it("exposes Allow and Deny in the overlay", () => {
    const markup = renderToStaticMarkup(<PreviewDownloadApprovalPrompt approvals={[approval]} />);
    expect(markup).toContain("data-preview-download-approval");
    expect(markup).toContain("grok.com wants to download a file");
    expect(markup).toContain("clip.mp4");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Allow for this domain");
  });

  it("renders the same answers at composer-banner size", () => {
    const markup = renderToStaticMarkup(
      <PreviewDownloadApprovalActions approval={approval} size="xs" />,
    );
    expect(markup).toContain("Deny");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Allow for this domain");
  });
});
