import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentGlyph } from "./AgentGlyph";

describe("AgentGlyph", () => {
  it("isolates each drawing in an image document so repeated agents cannot share gradient IDs", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentGlyph agentId="one" online />
        <AgentGlyph agentId="one" online={false} />
        <AgentGlyph agentId="two" online />
      </>,
    );
    expect(markup.match(/<img /g)).toHaveLength(3);
    expect(markup).not.toContain("<svg");
    expect(markup.match(/alt=""/g)).toHaveLength(3);
    const sources = [...markup.matchAll(/<img[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(sources).size).toBe(3);
  });
});
