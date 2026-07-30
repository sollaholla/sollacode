import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { isReconnectingOverlayActive, ReconnectingOverlayView } from "./ReconnectingOverlay";
import { SidebarInset, SidebarInsetOverlayProvider } from "./ui/sidebar";

describe("ReconnectingOverlay", () => {
  it("covers only the main content pane with a spinner while reconnecting", () => {
    const html = renderToStaticMarkup(<ReconnectingOverlayView active label="Local" />);
    expect(html).toContain("data-reconnecting-overlay");
    expect(html).toContain("animate-spin");
    expect(html).toContain("Reconnecting");
    expect(html).toContain("Restoring the connection to Local");
    expect(html).toContain('role="status"');
    expect(html).toContain("absolute inset-0");
    expect(html).not.toContain("fixed inset-0");
  });

  it("mounts inside the sidebar inset instead of over the project sidebar", () => {
    const html = renderToStaticMarkup(
      <SidebarInsetOverlayProvider overlay={<ReconnectingOverlayView active label="Local" />}>
        <aside data-app-sidebar="true">Projects</aside>
        <SidebarInset>Conversation</SidebarInset>
      </SidebarInsetOverlayProvider>,
    );

    const sidebarEnd = html.indexOf("</aside>");
    const mainStart = html.indexOf('data-slot="sidebar-inset"');
    const overlayStart = html.indexOf("data-reconnecting-overlay");
    const mainEnd = html.indexOf("</main>");
    expect(sidebarEnd).toBeLessThan(mainStart);
    expect(mainStart).toBeLessThan(overlayStart);
    expect(overlayStart).toBeLessThan(mainEnd);
  });

  it("renders nothing outside reconnect state", () => {
    expect(renderToStaticMarkup(<ReconnectingOverlayView active={false} />)).toBe("");
  });

  it.each<EnvironmentConnectionPhase>([
    "available",
    "offline",
    "connecting",
    "reconnecting",
    "connected",
    "error",
  ])("is tied exactly to the %s presentation phase", (phase) => {
    expect(isReconnectingOverlayActive(phase)).toBe(phase === "reconnecting");
  });
});
