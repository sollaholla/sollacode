import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  PASTE_COMMAND,
} from "lexical";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";
import type { ComposerPromptEditorHandle } from "./ComposerPromptEditor";

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

describe("registerComposerInlineTokenPaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a copied mention without also running the plain-text paste fallback", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[improve-deploy-error-logging.md](.changeset/improve-deploy-error-logging.md)";
    const plainTextFallback = vi.fn(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(mention);
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:.changeset/improve-deploy-error-logging.md> ",
    );
  });

  it.each([
    "yarn expo install @expo/ui",
    "npm install @jane/foo.js",
    "import '@scope/pkg/sub/path'",
  ])("leaves scoped package command %s to the plain-text paste fallback", (command) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn((event: ClipboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(command);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(command);
  });

  it("pastes a canonical scoped folder link as a mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[sub](@scope/pkg/sub)";
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:@scope/pkg/sub> ",
    );
  });
});

describe("ComposerPromptEditor placeholder", () => {
  it("renders one geometry-matched overlay without Lexical's extra placeholder wrapper", async () => {
    const { ComposerPromptEditor } = await import("./ComposerPromptEditor");
    const placeholder = "Ask anything, @tag files/folders, $use skills, or / for commands";
    const markup = renderToStaticMarkup(
      createElement(ComposerPromptEditor, {
        value: "",
        cursor: 0,
        terminalContexts: [],
        skills: [],
        disabled: false,
        placeholder,
        onRemoveTerminalContext: () => {},
        onChange: () => {},
        onPaste: () => {},
        editorRef: createRef<ComposerPromptEditorHandle | null>(),
      }),
    );

    expect(markup).toContain('data-testid="composer-editor"');
    expect(markup).toContain(
      'aria-placeholder="Ask anything, @tag files/folders, $use skills, or / for commands"',
    );
    expect(markup).toContain('data-testid="composer-placeholder"');
    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).not.toContain("absolute inset-0");
  });

  it("renders a Safari-owned textarea on iOS instead of a contenteditable", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Version/18.6 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const { ComposerPromptEditor } = await import("./ComposerPromptEditor");
    const markup = renderToStaticMarkup(
      createElement(ComposerPromptEditor, {
        value: "dictated text",
        cursor: 13,
        terminalContexts: [],
        skills: [],
        disabled: false,
        placeholder: "Ask anything",
        onRemoveTerminalContext: () => {},
        onChange: () => {},
        onPaste: () => {},
        editorRef: createRef<ComposerPromptEditorHandle | null>(),
      }),
    );

    expect(markup).toContain('data-native-ios-editor="true"');
    expect(markup).toContain("<textarea");
    expect(markup).toContain("touch-auto");
    expect(markup).not.toContain('contenteditable="true"');
    expect(markup).not.toContain('data-testid="composer-placeholder"');
  });
});
