// @vitest-environment happy-dom

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "compact", description: "Clear history but keep a summary in context" },
];

describe("provider slash commands in the rich composer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("colours the leading command, explains it on click, and leaves the rest plain", async () => {
    await act(async () => {
      root.render(
        <ComposerPromptEditor
          value="/compact keep the auth notes"
          cursor={0}
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

    const command = host.querySelector<HTMLElement>('[style*="--solla-slash-command"]');
    expect(command?.textContent).toBe("/compact");
    expect(host.querySelector('[contenteditable="true"]')?.textContent).toBe(
      "/compact keep the auth notes",
    );

    await act(async () => {
      command!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Clear history but keep a summary in context");
  });
});
