import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { QuickConnectQrPanel } from "./QuickConnectDevice";

describe("QuickConnectQrPanel", () => {
  it("renders a large, resilient QR code and a copyable full link", () => {
    const pairingUrl = "http://10.2.1.243:3773/pair#token=ONE_TIME_TOKEN";
    const markup = renderToStaticMarkup(
      <QuickConnectQrPanel pairingUrl={pairingUrl} onCopy={vi.fn()} />,
    );

    expect(markup).toContain('width="272"');
    expect(markup).toContain('height="272"');
    expect(markup).toContain("Scan to connect this device to Solla Code");
    expect(markup).toContain('aria-label="Device connection link"');
    expect(markup).toContain("Copy connection link");
    expect(markup).toContain(pairingUrl);
  });
});
