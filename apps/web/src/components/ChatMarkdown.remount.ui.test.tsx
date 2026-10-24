// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import ChatMarkdown from "./ChatMarkdown";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("keeps a link's favicon element when the caller rebuilds the low-context action every render", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () =>
      root.render(
        <ChatMarkdown
          text="See [the issue](https://github.com/example/repo/issues/1) for details."
          cwd={undefined}
          lowContextWarningAction={{ onCompactAndContinue: () => {}, busy: false }}
        />,
      ),
    );
  try {
    await render();
    const first = container.querySelector(
      ".chat-markdown-link-favicon img, .chat-markdown-link-favicon svg",
    );
    expect(first).not.toBeNull();
    await render();
    await render();
    expect(
      container.querySelector(".chat-markdown-link-favicon img, .chat-markdown-link-favicon svg"),
    ).toBe(first);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
