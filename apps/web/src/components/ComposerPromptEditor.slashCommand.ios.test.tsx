// @vitest-environment happy-dom

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE_NAVIGATOR = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Version/18.6 Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
};

const COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "compact", description: "Clear history but keep a summary in context" },
];

describe("provider slash commands in the iOS composer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("navigator", IPHONE_NAVIGATOR);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const renderEditor = async (value: string) => {
    await act(async () => {
      root.render(
        <ComposerPromptEditor
          value={value}
          cursor={value.length}
          terminalContexts={[]}
          skills={[]}
          providerSlashCommands={COMMANDS}
          disabled={false}
          placeholder="Ask anything"
          onRemoveTerminalContext={() => {}}
          onChange={() => {}}
          onPaste={() => {}}
          editorRef={createRef<ComposerPromptEditorHandle | null>()}
        />,
      );
    });
  };

  it("draws the leading command in link colour behind the textarea, with other text", async () => {
    await renderEditor("/compact keep the auth notes");
    const textarea = host.querySelector("textarea")!;
    const command = host.querySelector(".composer-provider-slash-command");

    expect(command?.textContent).toBe("/compact");
    expect(command?.parentElement?.textContent).toContain(" keep the auth notes");
    // The textarea's own glyphs step aside so the coloured copy shows.
    expect(textarea.className).toContain("text-transparent");
  });

  it("leaves an ordinary message's textarea untouched", async () => {
    await renderEditor("please /compact");
    expect(host.querySelector(".composer-provider-slash-command")).toBeNull();
    expect(host.querySelector("textarea")!.className).not.toContain("text-transparent");
  });

  it("follows the text as it is typed", async () => {
    await renderEditor("");
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      textarea.value = "/compact";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".composer-provider-slash-command")?.textContent).toBe("/compact");

    await act(async () => {
      textarea.value = "/compactly";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".composer-provider-slash-command")).toBeNull();
  });

  it("explains the command when it is tapped", async () => {
    await renderEditor("/compact");
    const command = host.querySelector(".composer-provider-slash-command")!;
    vi.spyOn(command, "getClientRects").mockReturnValue([
      { left: 10, right: 80, top: 10, bottom: 30 },
    ] as unknown as DOMRectList);

    await act(async () => {
      host
        .querySelector("textarea")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 40, clientY: 20 }));
    });

    expect(document.body.textContent).toContain("Clear history but keep a summary in context");
  });
});
