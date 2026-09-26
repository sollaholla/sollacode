import type { PreviewContextMenuTarget } from "@t3tools/contracts";

import type { TouchAction, TouchMenuState, TouchPoint } from "../remoteControl/touchActionMenu";

/** Longest `type` action the remote input contract accepts. */
const REMOTE_TYPE_MAX_CHARS = 4_096;
/** Longest press-and-hold the desktop's drag operation will hold for. */
export const REMOTE_HOLD_MAX_MS = 5_000;

/**
 * One finished touch gesture on the mirrored frame, in viewport pixels. The
 * mirror cannot stream a press the way the remote desktop does - each action
 * is one request followed by a fresh frame - so held gestures are sent whole
 * when the finger lifts.
 */
export type RemoteBrowserTouchGesture =
  | { readonly kind: "click"; readonly at: TouchPoint }
  | { readonly kind: "contextMenu"; readonly at: TouchPoint }
  | {
      readonly kind: "drag";
      readonly from: TouchPoint;
      readonly to: TouchPoint;
      readonly button?: "left" | "right";
      readonly holdMs?: number;
    };

/**
 * Turns the remote-control touch menu's press stream into whole gestures.
 * Wire `menu` and `pointer` into createTouchActionMenu's callbacks; the menu
 * state says which action the press belongs to, and arrives before its press.
 */
export function createRemoteBrowserTouchGestures(options: {
  readonly gesture: (gesture: RemoteBrowserTouchGesture) => void;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let activated: TouchAction | null = null;
  let press: { origin: TouchPoint; last: TouchPoint; at: number } | null = null;
  return {
    menu(state: TouchMenuState | null) {
      // The menu closes after the release that ends the gesture, so clearing
      // here never races the press it describes.
      activated = state?.activated ?? null;
    },
    pointer(action: "down" | "move" | "up", point: TouchPoint, button: "left" | "right") {
      if (action === "down") {
        press = { origin: point, last: point, at: now() };
        return;
      }
      if (press === null) return;
      if (action === "move") {
        press.last = point;
        return;
      }
      const { origin, last, at } = press;
      press = null;
      switch (activated) {
        case null:
          options.gesture({ kind: "click", at: origin });
          return;
        case "right-click":
          options.gesture({ kind: "contextMenu", at: origin });
          return;
        case "drag":
          options.gesture({ kind: "drag", from: origin, to: last });
          return;
        case "left-hold":
        case "right-hold":
          options.gesture({
            kind: "drag",
            from: origin,
            to: origin,
            button,
            holdMs: Math.min(REMOTE_HOLD_MAX_MS, Math.max(0, Math.round(now() - at))),
          });
          return;
        default:
          return;
      }
    },
    /** Drops a press in flight without sending it: a second finger began a pinch. */
    abandon() {
      press = null;
    },
  };
}

export type RemoteKeyboardEntry =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly key: string };

/**
 * Orders on-screen keyboard input for the mirrored tab. Each entry is a server
 * round trip, so characters typed while one is in flight ride together in the
 * next `type` rather than queueing a request apiece; keys stay in their place
 * between the runs of text around them.
 */
export function createRemoteKeyboardQueue(send: (entry: RemoteKeyboardEntry) => Promise<unknown>) {
  const pending: RemoteKeyboardEntry[] = [];
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        await send(next);
      }
    } finally {
      draining = false;
    }
  };
  return {
    push(entry: RemoteKeyboardEntry) {
      if (entry.kind === "text" && entry.text.length === 0) return;
      const last = pending.at(-1);
      if (
        entry.kind === "text" &&
        last?.kind === "text" &&
        last.text.length + entry.text.length <= REMOTE_TYPE_MAX_CHARS
      ) {
        pending[pending.length - 1] = { kind: "text", text: last.text + entry.text };
      } else if (entry.kind === "text" && entry.text.length > REMOTE_TYPE_MAX_CHARS) {
        for (let index = 0; index < entry.text.length; index += REMOTE_TYPE_MAX_CHARS) {
          pending.push({
            kind: "text",
            text: entry.text.slice(index, index + REMOTE_TYPE_MAX_CHARS),
          });
        }
      } else {
        pending.push(entry);
      }
      void drain();
    },
    /** Forgets what has not been sent yet: the tab changed under the keyboard. */
    clear() {
      pending.length = 0;
    },
  };
}

export type RemoteContextMenuItemId =
  | "open-link-host"
  | "open-link-here"
  | "copy-link"
  | "open-media-host"
  | "copy-media"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "search"
  | "back"
  | "forward"
  | "reload"
  | "copy-page";

export interface RemoteContextMenuItem {
  readonly id: RemoteContextMenuItemId;
  readonly label: string;
}

const OPENABLE_MEDIA = new Set(["image", "video", "audio"]);

/** Only web addresses are opened; a `javascript:` link is copied, never run. */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The groups the in-app menu shows for what sat under the pointer, in the
 * order a desktop browser lists them. Empty groups are dropped.
 */
export function remoteContextMenuItems(
  target: PreviewContextMenuTarget,
  options: { readonly canOpenInNewTab: boolean },
): ReadonlyArray<ReadonlyArray<RemoteContextMenuItem>> {
  const selection = target.selectionText.trim().length > 0;
  const link = target.linkUrl.length > 0;
  const media = target.srcUrl.length > 0 && OPENABLE_MEDIA.has(target.mediaType);
  const groups: RemoteContextMenuItem[][] = [];
  if (link) {
    const group: RemoteContextMenuItem[] = [];
    if (isOpenableUrl(target.linkUrl)) {
      if (options.canOpenInNewTab)
        group.push({ id: "open-link-host", label: "Open link in new tab" });
      group.push({ id: "open-link-here", label: "Open link on this device" });
    }
    group.push({ id: "copy-link", label: "Copy link address" });
    groups.push(group);
  }
  if (media) {
    const noun = target.mediaType === "image" ? "image" : target.mediaType;
    const group: RemoteContextMenuItem[] = [];
    if (options.canOpenInNewTab && isOpenableUrl(target.srcUrl))
      group.push({ id: "open-media-host", label: `Open ${noun} in new tab` });
    group.push({ id: "copy-media", label: `Copy ${noun} address` });
    groups.push(group);
  }
  if (target.isEditable) {
    const group: RemoteContextMenuItem[] = [];
    if (target.canUndo) group.push({ id: "undo", label: "Undo" });
    if (target.canRedo) group.push({ id: "redo", label: "Redo" });
    groups.push(group);
    const edits: RemoteContextMenuItem[] = [];
    if (selection) edits.push({ id: "cut", label: "Cut" }, { id: "copy", label: "Copy" });
    edits.push({ id: "paste", label: "Paste" });
    if (target.canSelectAll) edits.push({ id: "select-all", label: "Select all" });
    groups.push(edits);
  } else if (selection) {
    groups.push([{ id: "copy", label: "Copy" }]);
  }
  if (selection && options.canOpenInNewTab) {
    groups.push([{ id: "search", label: "Search the web" }]);
  }
  if (!link && !media && !selection && !target.isEditable) {
    const group: RemoteContextMenuItem[] = [];
    if (target.canGoBack) group.push({ id: "back", label: "Back" });
    if (target.canGoForward) group.push({ id: "forward", label: "Forward" });
    group.push({ id: "reload", label: "Reload" });
    if (target.pageUrl.length > 0) group.push({ id: "copy-page", label: "Copy page address" });
    groups.push(group);
  }
  return groups.filter((group) => group.length > 0);
}

/** Search URL for "Search the web", matching the desktop's own guest menu. */
export function remoteSearchUrl(selection: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(selection.trim().slice(0, 1_000))}`;
}

/**
 * Wires the hidden field that receives the on-screen keyboard. The field is
 * read, never steered: whatever the keyboard put in it (a letter, a predicted
 * word, a paste, a finished IME composition) is sent as text and the field is
 * emptied again. A composition stays in the field until it ends, because
 * clearing it mid-word throws Android's keyboard off. Named keys go to the page
 * as presses, and Backspace only when there is nothing local to delete.
 *
 * React's `onBeforeInput` cannot do this job: its synthetic event carries no
 * `inputType`, so cancelling it by type dropped every letter.
 */
export function attachRemoteKeyboardInput(
  input: HTMLInputElement,
  options: {
    readonly forwardedKeys: ReadonlySet<string>;
    readonly onText: (text: string) => void;
    readonly onKey: (key: string) => void;
    /** True while a pinch owns the gesture; keyboard input is discarded then. */
    readonly isBlocked: () => boolean;
  },
): () => void {
  let composing = false;
  const flush = () => {
    const text = input.value;
    if (text.length === 0) return;
    input.value = "";
    if (!options.isBlocked()) options.onText(text);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (options.isBlocked() || !options.forwardedKeys.has(event.key)) return;
    if (event.key === "Backspace" && input.value.length > 0) return;
    event.preventDefault();
    flush();
    options.onKey(event.key);
  };
  const onBeforeInput = (event: InputEvent) => {
    if (composing || event.isComposing) return;
    // Keyboards that report every key as "Unidentified" still describe the
    // edit; an empty field has nothing to delete or break, so the page gets it.
    const key =
      event.inputType === "deleteContentBackward" && input.value.length === 0
        ? "Backspace"
        : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph"
          ? "Enter"
          : null;
    if (key === null) return;
    event.preventDefault();
    flush();
    if (!options.isBlocked()) options.onKey(key);
  };
  const onInput = (event: Event) => {
    if (composing || (event as InputEvent).isComposing) return;
    flush();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    flush();
  };
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  return () => {
    input.removeEventListener("keydown", onKeyDown);
    input.removeEventListener("beforeinput", onBeforeInput);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("compositionend", onCompositionEnd);
  };
}
