// @vitest-environment happy-dom

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

describe("ComposerPromptEditor on iOS WebKit", () => {
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

  it("keeps Safari's live dictation value when a lagging prop echo renders", async () => {
    const onChange = vi.fn();
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    const renderEditor = async (value: string, cursor: number) => {
      await act(async () => {
        root.render(
          <ComposerPromptEditor
            value={value}
            cursor={cursor}
            terminalContexts={[]}
            skills={[]}
            disabled={false}
            placeholder="Ask anything"
            onRemoveTerminalContext={() => {}}
            onChange={onChange}
            onPaste={() => {}}
            editorRef={editorRef}
          />,
        );
      });
    };

    await renderEditor("", 0);
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    act(() => {
      textarea!.value = "call me at four";
      textarea!.setSelectionRange(15, 15);
      textarea!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      textarea!.value = "call me at four thirty";
      textarea!.setSelectionRange(22, 22);
      textarea!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    expect(onChange).toHaveBeenNthCalledWith(1, "call me at four", 15, 15, false, []);
    expect(onChange).toHaveBeenLastCalledWith("call me at four thirty", 22, 22, false, []);

    act(() => {
      textarea!.value = "call me at four thirty";
      textarea!.setSelectionRange(22, 22);
    });

    // The store can render an earlier word while dictation is still streaming.
    // A controlled editor writes this into the DOM and corrupts Safari's final
    // correction target; the native path must leave the DOM untouched.
    await renderEditor("call me at four", 15);
    expect(textarea!.value).toBe("call me at four thirty");

    act(() => {
      textarea!.value = "call me at 4:30";
      textarea!.setSelectionRange(15, 15);
      textarea!.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith("call me at 4:30", 15, 15, false, []);
    expect(editorRef.current?.readSnapshot().value).toBe("call me at 4:30");
  });

  it("leaves native selection and touch gestures unrestricted", async () => {
    await act(async () => {
      root.render(
        <ComposerPromptEditor
          value="double tap this word"
          cursor={20}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Ask anything"
          onRemoveTerminalContext={() => {}}
          onChange={() => {}}
          onPaste={() => {}}
          editorRef={createRef<ComposerPromptEditorHandle | null>()}
        />,
      );
    });

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.className).toContain("touch-auto");
    expect(textarea?.getAttribute("contenteditable")).toBeNull();

    const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    textarea?.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(false);

    textarea?.setSelectionRange(7, 10);
    textarea?.dispatchEvent(new Event("select", { bubbles: true }));
    expect(textarea?.selectionStart).toBe(7);
    expect(textarea?.selectionEnd).toBe(10);
  });

  it("does not resize or collapse a native selection when its cursor echo renders", async () => {
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    const renderEditor = async (cursor: number) => {
      await act(async () => {
        root.render(
          <ComposerPromptEditor
            value="select this entire range"
            cursor={cursor}
            terminalContexts={[]}
            skills={[]}
            disabled={false}
            placeholder="Ask anything"
            onRemoveTerminalContext={() => {}}
            onChange={() => {}}
            onPaste={() => {}}
            editorRef={editorRef}
          />,
        );
      });
    };
    await renderEditor(24);
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(7, 17, "backward");
    const setHeight = vi.spyOn(textarea.style, "height", "set");

    await renderEditor(7);

    expect(textarea.selectionStart).toBe(7);
    expect(textarea.selectionEnd).toBe(17);
    expect(textarea.selectionDirection).toBe("backward");
    expect(document.activeElement).toBe(textarea);
    expect(setHeight).not.toHaveBeenCalled();
    setHeight.mockRestore();
  });
});
