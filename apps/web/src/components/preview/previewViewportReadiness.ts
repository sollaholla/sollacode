import type { PreviewRenderedViewportSize, PreviewViewportSetting } from "@t3tools/contracts";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

export function isPreviewViewportReady(input: {
  readonly setting: PreviewViewportSetting;
  readonly appliedSettingKey: string | null;
  readonly declaredViewport: PreviewRenderedViewportSize | null;
  readonly renderedViewport: PreviewRenderedViewportSize | null;
}): boolean {
  const { setting, appliedSettingKey, declaredViewport, renderedViewport } = input;
  if (
    appliedSettingKey !== browserViewportSettingKey(setting) ||
    declaredViewport === null ||
    renderedViewport === null
  ) {
    return false;
  }

  // Fill owns the available host rectangle, so the guest's measured viewport
  // is authoritative. Electron app zoom may make it differ from the renderer's
  // declared host size; forcing those values to match expands the webview past
  // its panel and clips the page. A matching applied key plus a live measured
  // viewport is sufficient to prove that Fill has landed.
  if (setting._tag === "fill") return true;

  const expectedViewport = { width: setting.width, height: setting.height };
  if (
    declaredViewport.width !== expectedViewport.width ||
    declaredViewport.height !== expectedViewport.height
  ) {
    return false;
  }

  // Electron rounds CSS pixels through the guest's fractional zoom/device scale,
  // so a successfully applied fixed viewport can measure one pixel either way.
  const tolerance = 1;
  return (
    Math.abs(renderedViewport.width - expectedViewport.width) <= tolerance &&
    Math.abs(renderedViewport.height - expectedViewport.height) <= tolerance
  );
}
