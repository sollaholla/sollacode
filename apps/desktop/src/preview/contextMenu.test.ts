import { describe, expect, it } from "vite-plus/test";

import {
  buildPreviewContextMenuTemplate,
  webSearchUrl,
  type PreviewContextMenuActions,
  type PreviewContextMenuParams,
} from "./contextMenu.ts";

const noEditFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
};

const params = (overrides: Partial<PreviewContextMenuParams> = {}): PreviewContextMenuParams => ({
  pageURL: "https://example.com/page",
  linkURL: "",
  linkText: "",
  srcURL: "",
  mediaType: "none",
  isEditable: false,
  selectionText: "",
  misspelledWord: "",
  dictionarySuggestions: [],
  editFlags: noEditFlags,
  ...overrides,
});

const recordingActions = (): {
  readonly actions: PreviewContextMenuActions;
  readonly calls: string[];
} => {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: readonly unknown[]) => {
      calls.push(args.length === 0 ? name : `${name}:${String(args[0])}`);
    };
  return {
    calls,
    actions: {
      goBack: record("goBack"),
      goForward: record("goForward"),
      reload: record("reload"),
      openInNewTab: record("openInNewTab"),
      openExternally: record("openExternally"),
      downloadUrl: record("downloadUrl"),
      copyText: record("copyText"),
      copyImage: record("copyImage"),
      searchWeb: record("searchWeb"),
      replaceMisspelling: record("replaceMisspelling"),
      addToDictionary: record("addToDictionary"),
      undo: record("undo"),
      redo: record("redo"),
      cut: record("cut"),
      copy: record("copy"),
      paste: record("paste"),
      pasteAndMatchStyle: record("pasteAndMatchStyle"),
      selectAll: record("selectAll"),
      print: record("print"),
      inspect: record("inspect"),
    },
  };
};

const labels = (template: readonly Electron.MenuItemConstructorOptions[]): string[] =>
  template.flatMap((item) => (typeof item.label === "string" ? [item.label] : []));

const state = { canGoBack: true, canGoForward: false };

describe("buildPreviewContextMenuTemplate", () => {
  it("offers page navigation when the click landed on nothing in particular", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(params(), state, actions);
    expect(labels(template)).toEqual([
      "Back",
      "Forward",
      "Reload",
      "Copy Page Address",
      "Open Page in Default Browser",
      "Print…",
      "Inspect Element",
    ]);
    const back = template.find((item) => item.label === "Back");
    const forward = template.find((item) => item.label === "Forward");
    expect(back?.enabled).toBe(true);
    expect(forward?.enabled).toBe(false);
  });

  it("replaces the page section with link items on a link", () => {
    const { actions, calls } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({ linkURL: "https://example.com/next", linkText: "Next" }),
      state,
      actions,
    );
    expect(labels(template)).toEqual([
      "Open Link in New Tab",
      "Open Link in Default Browser",
      "Copy Link Address",
      "Copy Link Text",
      "Inspect Element",
    ]);
    template
      .find((item) => item.label === "Open Link in New Tab")
      ?.click?.(undefined as never, undefined, undefined as never);
    expect(calls).toEqual(["openInNewTab:https://example.com/next"]);
  });

  it("keeps link and image items together when a link wraps an image", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({
        linkURL: "https://example.com/next",
        srcURL: "https://example.com/cat.png",
        mediaType: "image",
      }),
      state,
      actions,
    );
    expect(labels(template)).toEqual([
      "Open Link in New Tab",
      "Open Link in Default Browser",
      "Copy Link Address",
      "Open Image in New Tab",
      "Save Image As…",
      "Copy Image",
      "Copy Image Address",
      "Inspect Element",
    ]);
  });

  it("mirrors the field's own edit flags rather than guessing", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({
        isEditable: true,
        editFlags: { ...noEditFlags, canPaste: true, canSelectAll: true },
      }),
      state,
      actions,
    );
    expect(labels(template)).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Paste and Match Style",
      "Select All",
      "Inspect Element",
    ]);
    expect(template.find((item) => item.label === "Cut")?.enabled).toBe(false);
    expect(template.find((item) => item.label === "Paste")?.enabled).toBe(true);
  });

  it("puts spelling suggestions above the editing items", () => {
    const { actions, calls } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "tech", "ten", "tea", "tel", "tee"],
      }),
      state,
      actions,
    );
    expect(labels(template).slice(0, 5)).toEqual(["the", "tech", "ten", "tea", "tel"]);
    expect(labels(template)).toContain("Add to Dictionary");
    template
      .find((item) => item.label === "the")
      ?.click?.(undefined as never, undefined, undefined as never);
    expect(calls).toEqual(["replaceMisspelling:the"]);
  });

  it("says so when a misspelling has no suggestions", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({ isEditable: true, misspelledWord: "qqqq", dictionarySuggestions: [] }),
      state,
      actions,
    );
    const empty = template.find((item) => item.label === "No Spelling Suggestions");
    expect(empty?.enabled).toBe(false);
  });

  it("shortens a long selection in the search label but searches all of it", () => {
    const { actions, calls } = recordingActions();
    const selection = "  the quick brown fox   jumps over the lazy dog  ";
    const template = buildPreviewContextMenuTemplate(
      params({ selectionText: selection }),
      state,
      actions,
    );
    expect(labels(template)).toEqual([
      "Copy",
      "Search the Web for “the quick brown fox jump…”",
      "Inspect Element",
    ]);
    template
      .find((item) => item.label?.toString().startsWith("Search"))
      ?.click?.(undefined as never, undefined, undefined as never);
    expect(calls).toEqual([`searchWeb:${selection.trim()}`]);
  });

  it("treats whitespace-only selections as no selection at all", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(
      params({ selectionText: "  \n " }),
      state,
      actions,
    );
    expect(labels(template)).toContain("Reload");
  });

  it("never emits a leading, trailing, or doubled separator", () => {
    const { actions } = recordingActions();
    for (const input of [
      params(),
      params({ linkURL: "https://example.com/next" }),
      params({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the"] }),
      params({ srcURL: "https://example.com/v.mp4", mediaType: "video" }),
      params({ pageURL: "" }),
    ]) {
      const template = buildPreviewContextMenuTemplate(input, state, actions);
      expect(template.at(0)?.type).not.toBe("separator");
      expect(template.at(-1)?.type).not.toBe("separator");
      for (let index = 1; index < template.length; index += 1) {
        const doubled =
          template[index]?.type === "separator" && template[index - 1]?.type === "separator";
        expect(doubled).toBe(false);
      }
    }
  });

  it("always ends with Inspect Element", () => {
    const { actions } = recordingActions();
    const template = buildPreviewContextMenuTemplate(params({ isEditable: true }), state, actions);
    expect(template.at(-1)?.label).toBe("Inspect Element");
  });
});

describe("webSearchUrl", () => {
  it("encodes the query", () => {
    expect(webSearchUrl(" moose  & elk ")).toBe(
      "https://www.google.com/search?q=moose%20%26%20elk",
    );
  });
});
