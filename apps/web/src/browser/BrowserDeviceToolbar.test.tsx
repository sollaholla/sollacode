import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";

describe("BrowserDeviceToolbar", () => {
  it("retains its layout without exposing inactive controls to accessibility or focus", () => {
    const markup = renderToStaticMarkup(
      <BrowserDeviceToolbar
        active={false}
        setting={{ _tag: "freeform", width: 390, height: 844 }}
        width={390}
        aspectRatio={null}
        onAspectRatioChange={vi.fn()}
        onChange={vi.fn(async () => undefined)}
      />,
    );
    const toolbar = markup.match(/^<div[^>]*>/)?.[0];

    expect(toolbar).toContain('role="toolbar"');
    expect(toolbar).toContain('aria-hidden="true"');
    expect(toolbar).toContain(' inert=""');
  });

  it("keeps the active toolbar available to assistive technology", () => {
    const markup = renderToStaticMarkup(
      <BrowserDeviceToolbar
        active
        setting={{ _tag: "freeform", width: 390, height: 844 }}
        width={390}
        aspectRatio={null}
        onAspectRatioChange={vi.fn()}
        onChange={vi.fn(async () => undefined)}
      />,
    );
    const toolbar = markup.match(/^<div[^>]*>/)?.[0];

    expect(toolbar).not.toContain('aria-hidden="true"');
    expect(toolbar).not.toContain(' inert=""');
  });
});
