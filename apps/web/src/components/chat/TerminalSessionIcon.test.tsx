import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TerminalSessionIcon } from "./TerminalSessionIcon";

describe("TerminalSessionIcon", () => {
  it("marks a working pane and keeps a generic terminal glyph when idle", () => {
    const working = renderToStaticMarkup(<TerminalSessionIcon working className="size-3" />);
    expect(working).toContain('data-terminal-working="true"');
    expect(working).toContain('aria-label="Terminal working"');
    expect(working).toContain("bg-sky-500");

    const idle = renderToStaticMarkup(<TerminalSessionIcon working={false} />);
    expect(idle).not.toContain("data-terminal-working");
    expect(idle).not.toContain("bg-sky-500");
  });

  it("uses the provider glyph when a CLI is running", () => {
    const markup = renderToStaticMarkup(
      <TerminalSessionIcon
        working
        driverKind={ProviderDriverKind.make("claudeAgent")}
        displayName="claude"
      />,
    );
    expect(markup).toContain("data-terminal-working");
  });

  it("keeps the provider glyph on an idle agent pane without a working dot", () => {
    const markup = renderToStaticMarkup(
      <TerminalSessionIcon
        working={false}
        driverKind={ProviderDriverKind.make("grok")}
        displayName="grok"
      />,
    );
    expect(markup).not.toContain("data-terminal-working");
    expect(markup).not.toContain("bg-sky-500");
  });
});
