import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentGlyph } from "./AgentGlyph";

describe("AgentGlyph", () => {
  it("isolates each drawing in image documents so repeated agents cannot share clip ids", () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentGlyph agentId="one" online />
        <AgentGlyph agentId="one" online={false} />
        <AgentGlyph agentId="two" online />
      </>,
    );
    expect(markup.match(/<img /g)).toHaveLength(6);
    expect(markup).not.toContain("<svg");
    expect(markup.match(/alt=""/g)).toHaveLength(6);
    const sources = [...markup.matchAll(/<img[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(sources).size).toBe(6);
  });
});
