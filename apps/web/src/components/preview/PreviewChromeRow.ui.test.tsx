// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow";
import { formatPreviewUrl } from "./previewUrlPresentation";

/**
 * The address a viewer on another machine is actually served from. The
 * resolver rewrites a `localhost` request to the environment's own address,
 * because that is the only one their browser can dial; both values below come
 * from the same environment connection, which is what makes them comparable.
 */
const ENVIRONMENT_HTTP_BASE_URL = "http://10.2.1.249:5799";
const RESOLVED_URL = "http://10.2.1.249:8999/";

async function mountChromeRow() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <PreviewChromeRow
        url={RESOLVED_URL}
        displayUrl={
          formatPreviewUrl({
            url: RESOLVED_URL,
            environmentLabel: "Studio",
            environmentHttpBaseUrl: ENVIRONMENT_HTTP_BASE_URL,
          }) ?? undefined
        }
        loading={false}
        loadProgress={0}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
  });

  const input = container.querySelector<HTMLInputElement>("input[data-preview-url-input]");
  if (!input) throw new Error("preview URL input did not render");

  return {
    input,
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("preview address bar", () => {
  it("names the site rather than the machine it is dialled through", async () => {
    const { input, dispose } = await mountChromeRow();

    expect(input.value).toBe("localhost:8999");

    await dispose();
  });

  it("hands back the real address the moment it is edited", async () => {
    // The friendly name is a label, not a substitute: typing into the bar has
    // to start from the address that actually resolves.
    const { input, dispose } = await mountChromeRow();

    await act(async () => {
      input.focus();
      input.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    });

    expect(input.value).toBe(RESOLVED_URL);

    await dispose();
  });
});
