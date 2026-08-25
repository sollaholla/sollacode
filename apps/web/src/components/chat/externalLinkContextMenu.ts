import type { ContextMenuItem } from "@t3tools/contracts";

export type ExternalLinkContextMenuAction = "open-in-preview" | "open-external" | "copy-link";

export type ExternalLinkContextMenuFailureOperation =
  | "show-link-context-menu"
  | "open-link-in-preview"
  | "open-link-external"
  | "copy-link";

export interface ExternalLinkActivation {
  readonly button: number;
  readonly defaultPrevented: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

const FAILURE_OPERATION_BY_ACTION = {
  "open-in-preview": "open-link-in-preview",
  "open-external": "open-link-external",
  "copy-link": "copy-link",
} as const satisfies Record<ExternalLinkContextMenuAction, ExternalLinkContextMenuFailureOperation>;

const EXTERNAL_LINK_CONTEXT_MENU_ITEMS = [
  { id: "open-in-preview", label: "Open in integrated browser" },
  { id: "open-external", label: "Open in system browser" },
  { id: "copy-link", label: "Copy Link" },
] as const satisfies readonly ContextMenuItem<ExternalLinkContextMenuAction>[];

interface ShowExternalLinkContextMenuOptions {
  readonly href: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly showContextMenu: (
    items: readonly ContextMenuItem<ExternalLinkContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ExternalLinkContextMenuAction | null>;
  readonly openInPreview: (href: string) => Promise<void>;
  readonly openExternal: (href: string) => Promise<void>;
  readonly copyLink: (href: string) => Promise<unknown>;
  readonly reportFailure: (
    operation: ExternalLinkContextMenuFailureOperation,
    cause: unknown,
  ) => void;
}

export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Handle an ordinary left click ourselves so embedded clients do not depend on
 * their implementation of target=_blank. Modified clicks remain native so
 * opening in a new tab/window keeps the platform's normal behavior.
 */
export function shouldOpenExternalLinkDirectly(event: ExternalLinkActivation): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export async function openExternalLinkDirectly(input: {
  readonly href: string;
  readonly openExternal: (href: string) => Promise<void>;
  readonly reportFailure: (cause: unknown) => void;
}): Promise<void> {
  try {
    await input.openExternal(input.href);
  } catch (cause) {
    input.reportFailure(cause);
  }
}

export async function showExternalLinkContextMenu({
  href,
  position,
  showContextMenu,
  openInPreview,
  openExternal,
  copyLink,
  reportFailure,
}: ShowExternalLinkContextMenuOptions): Promise<void> {
  let action: ExternalLinkContextMenuAction | null;
  try {
    action = await showContextMenu(EXTERNAL_LINK_CONTEXT_MENU_ITEMS, position);
  } catch (cause) {
    reportFailure("show-link-context-menu", cause);
    return;
  }

  try {
    if (action === "open-in-preview") {
      await openInPreview(href);
    } else if (action === "open-external") {
      await openExternal(href);
    } else if (action === "copy-link") {
      await copyLink(href);
    }
  } catch (cause) {
    if (action) reportFailure(FAILURE_OPERATION_BY_ACTION[action], cause);
  }
}
