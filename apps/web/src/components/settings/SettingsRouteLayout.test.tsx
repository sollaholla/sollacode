import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "../../browser/hostedBrowserWebviewStyle";
import { SETTINGS_ROUTE_SURFACE_Z_INDEX, SettingsRouteLayout } from "./SettingsRouteLayout";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="settings-outlet" />,
  useCanGoBack: () => false,
  useLocation: () => ({ pathname: "/settings/appearance" }),
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock("../../env", () => ({ isElectron: false }));

vi.mock("./SettingsPanels", () => ({
  useSettingsRestore: () => ({
    changedSettingLabels: [],
    restoreDefaults: () => Promise.resolve(),
  }),
}));

describe("SettingsRouteLayout", () => {
  it("layers the rendered settings surface above a still-presented preview webview", () => {
    const previewStyle = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      rect: { x: 320, y: 0, width: 960, height: 800 },
      hiddenSize: { width: 1280, height: 800 },
    });
    const markup = renderToStaticMarkup(<SettingsRouteLayout />);

    expect(SETTINGS_ROUTE_SURFACE_Z_INDEX).toBeGreaterThan(previewStyle.zIndex);
    expect(markup).toContain('data-slot="sidebar-inset"');
    expect(markup).toContain(`style="z-index:${SETTINGS_ROUTE_SURFACE_Z_INDEX}"`);
  });
});
