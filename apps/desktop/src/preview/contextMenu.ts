/**
 * Right-click menu for the in-app browser.
 *
 * Chrome decides what a context menu contains from what sits under the
 * pointer, not from a fixed list: a link gets link items, an image gets image
 * items, a text field gets editing items. This module reproduces that shape as
 * a pure function so the arrangement can be tested without Electron, and adds
 * the entries that only make sense for a browser embedded in an app — opening
 * something in the user's real browser, and copying the page address.
 */

export interface PreviewContextMenuEditFlags {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canCut: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly canSelectAll: boolean;
}

export interface PreviewContextMenuParams {
  readonly pageURL: string;
  readonly linkURL: string;
  readonly linkText: string;
  readonly srcURL: string;
  readonly mediaType: string;
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly editFlags: PreviewContextMenuEditFlags;
}

export interface PreviewContextMenuState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface PreviewContextMenuActions {
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
  readonly openInNewTab: (url: string) => void;
  readonly openExternally: (url: string) => void;
  readonly downloadUrl: (url: string) => void;
  readonly copyText: (text: string) => void;
  readonly copyImage: () => void;
  readonly searchWeb: (query: string) => void;
  readonly replaceMisspelling: (word: string) => void;
  readonly addToDictionary: (word: string) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly cut: () => void;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly pasteAndMatchStyle: () => void;
  readonly selectAll: () => void;
  readonly print: () => void;
  readonly inspect: () => void;
}

const SEARCH_LABEL_MAX_CHARS = 24;

// A selection can be an entire paragraph; menus are not a place to render one.
const summarizeSelection = (selection: string): string => {
  const collapsed = selection.replace(/\s+/gu, " ").trim();
  return collapsed.length <= SEARCH_LABEL_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, SEARCH_LABEL_MAX_CHARS)}…`;
};

const isPresent = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;

export const buildPreviewContextMenuTemplate = (
  params: PreviewContextMenuParams,
  state: PreviewContextMenuState,
  actions: PreviewContextMenuActions,
): Electron.MenuItemConstructorOptions[] => {
  const sections: Electron.MenuItemConstructorOptions[][] = [];
  const hasLink = isPresent(params.linkURL);
  const hasImage = params.mediaType === "image" && isPresent(params.srcURL);
  const hasMedia =
    (params.mediaType === "video" || params.mediaType === "audio") && isPresent(params.srcURL);
  const selection = isPresent(params.selectionText) ? params.selectionText.trim() : "";
  const hasSelection = selection.length > 0;

  if (hasLink) {
    const linkURL = params.linkURL;
    sections.push([
      { label: "Open Link in New Tab", click: () => actions.openInNewTab(linkURL) },
      { label: "Open Link in Default Browser", click: () => actions.openExternally(linkURL) },
      { label: "Copy Link Address", click: () => actions.copyText(linkURL) },
      ...(isPresent(params.linkText)
        ? [{ label: "Copy Link Text", click: () => actions.copyText(params.linkText) }]
        : []),
    ]);
  }

  if (hasImage) {
    const srcURL = params.srcURL;
    sections.push([
      { label: "Open Image in New Tab", click: () => actions.openInNewTab(srcURL) },
      { label: "Save Image As…", click: () => actions.downloadUrl(srcURL) },
      { label: "Copy Image", click: () => actions.copyImage() },
      { label: "Copy Image Address", click: () => actions.copyText(srcURL) },
    ]);
  }

  if (hasMedia) {
    const srcURL = params.srcURL;
    const noun = params.mediaType === "video" ? "Video" : "Audio";
    sections.push([
      { label: `Save ${noun} As…`, click: () => actions.downloadUrl(srcURL) },
      { label: `Copy ${noun} Address`, click: () => actions.copyText(srcURL) },
    ]);
  }

  if (params.isEditable) {
    if (isPresent(params.misspelledWord)) {
      const misspelledWord = params.misspelledWord;
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      sections.push([
        ...(suggestions.length > 0
          ? suggestions.map(
              (suggestion): Electron.MenuItemConstructorOptions => ({
                label: suggestion,
                click: () => actions.replaceMisspelling(suggestion),
              }),
            )
          : [{ label: "No Spelling Suggestions", enabled: false }]),
        { type: "separator" },
        { label: "Add to Dictionary", click: () => actions.addToDictionary(misspelledWord) },
      ]);
    }
    sections.push([
      { label: "Undo", enabled: params.editFlags.canUndo, click: () => actions.undo() },
      { label: "Redo", enabled: params.editFlags.canRedo, click: () => actions.redo() },
      { type: "separator" },
      { label: "Cut", enabled: params.editFlags.canCut, click: () => actions.cut() },
      { label: "Copy", enabled: params.editFlags.canCopy, click: () => actions.copy() },
      { label: "Paste", enabled: params.editFlags.canPaste, click: () => actions.paste() },
      {
        label: "Paste and Match Style",
        enabled: params.editFlags.canPaste,
        click: () => actions.pasteAndMatchStyle(),
      },
      {
        label: "Select All",
        enabled: params.editFlags.canSelectAll,
        click: () => actions.selectAll(),
      },
    ]);
  } else if (hasSelection) {
    sections.push([
      { label: "Copy", click: () => actions.copy() },
      {
        label: `Search the Web for “${summarizeSelection(selection)}”`,
        click: () => actions.searchWeb(selection),
      },
    ]);
  }

  // Page items are the fallback context, exactly as in Chrome: they appear when
  // the click did not land on anything more specific.
  if (!hasLink && !hasImage && !hasMedia && !params.isEditable && !hasSelection) {
    sections.push([
      { label: "Back", enabled: state.canGoBack, click: () => actions.goBack() },
      { label: "Forward", enabled: state.canGoForward, click: () => actions.goForward() },
      { label: "Reload", click: () => actions.reload() },
      { type: "separator" },
      ...(isPresent(params.pageURL)
        ? [
            {
              label: "Copy Page Address",
              click: () => actions.copyText(params.pageURL),
            },
            {
              label: "Open Page in Default Browser",
              click: () => actions.openExternally(params.pageURL),
            },
          ]
        : []),
      { label: "Print…", click: () => actions.print() },
    ]);
  }

  sections.push([{ label: "Inspect Element", click: () => actions.inspect() }]);

  const template: Electron.MenuItemConstructorOptions[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...section);
  }
  return template;
};

const SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

export const webSearchUrl = (query: string): string =>
  `${SEARCH_URL_PREFIX}${encodeURIComponent(query.replace(/\s+/gu, " ").trim())}`;
