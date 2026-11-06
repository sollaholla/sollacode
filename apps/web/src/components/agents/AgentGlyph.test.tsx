import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentGlyph } from "./AgentGlyph";

describe("AgentGlyph", () => {
  it("stacks gas, stars and glass, adding the status mark only when there is one", () => {
    const count = (markup: string) => markup.match(/<img /g)?.length;
    expect(count(renderToStaticMarkup(<AgentGlyph agentId="one" online />))).toBe(3);
    expect(count(renderToStaticMarkup(<AgentGlyph agentId="one" online mood="happy" />))).toBe(4);
    expect(count(renderToStaticMarkup(<AgentGlyph agentId="one" online={false} />))).toBe(4);
  });

  it("gives two agents different orbs by their stored color", () => {
    const orb = (avatarColor: number) =>
      /data-orb="([a-z]+)"/.exec(
        renderToStaticMarkup(<AgentGlyph agentId="one" online avatarColor={avatarColor} />),
      )?.[1];
    expect(orb(0)).toBe("orion");
    expect(orb(1)).toBe("abyss");
  });

  it("plays the 3D clip only where asked, and never offline", () => {
    expect(renderToStaticMarkup(<AgentGlyph agentId="one" online />)).not.toContain("<video");
    expect(renderToStaticMarkup(<AgentGlyph agentId="one" online live />)).toContain("<video");
    expect(renderToStaticMarkup(<AgentGlyph agentId="one" online={false} live />)).not.toContain(
      "<video",
    );
  });

  it("stays decorative", () => {
    const markup = renderToStaticMarkup(<AgentGlyph agentId="one" online />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/alt=""/g)).toHaveLength(3);
  });
});
