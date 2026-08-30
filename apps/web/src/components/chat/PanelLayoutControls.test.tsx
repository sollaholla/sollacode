import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("keeps the right-panel toggle enabled when its thread is available", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        onToggleRightPanel={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Toggle right panel"');
    expect(markup).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("still disables the toggle when there is no thread to own it", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        onToggleRightPanel={vi.fn()}
      />,
    );

    expect(markup).toMatch(/\sdisabled(?:=|\s|>)/);
  });
});
