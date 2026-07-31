import { randomUUID } from "~/lib/utils";

const COMPOSER_TRANSFER_MIME = "application/x-solla-composer-transfer";
const MAX_STAGED_TRANSFERS = 8;
const TRANSFER_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{12,160}$/u;

type StagedComposerTransfer = {
  readonly token: string;
  readonly prompt: string;
  readonly files: ReadonlyArray<File>;
};

export type ComposerTransfer = {
  readonly prompt: string;
  readonly files: ReadonlyArray<File>;
};

const stagedTransfers = new Map<string, StagedComposerTransfer>();

function cloneFile(file: File): File {
  return new File([file], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function newTransferToken(): string {
  return `solla-${randomUUID()}`;
}

function trimStagedTransfers(): void {
  while (stagedTransfers.size > MAX_STAGED_TRANSFERS) {
    const oldestToken = stagedTransfers.keys().next().value;
    if (typeof oldestToken !== "string") return;
    stagedTransfers.delete(oldestToken);
  }
}

function transferTokenFromHtml(html: string): string | null {
  const match = /data-solla-composer-transfer\s*=\s*["']([^"']+)["']/iu.exec(html);
  const token = match?.[1]?.trim() ?? "";
  return TRANSFER_TOKEN_PATTERN.test(token) ? token : null;
}

function writeWithCopyEvent(input: {
  readonly token: string;
  readonly prompt: string;
  readonly html: string;
}): boolean {
  if (
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function" ||
    typeof document.execCommand !== "function"
  ) {
    return false;
  }

  let wroteClipboardData = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", input.prompt);
    event.clipboardData.setData("text/html", input.html);
    event.clipboardData.setData(COMPOSER_TRANSFER_MIME, input.token);
    wroteClipboardData = true;
  };

  document.addEventListener("copy", onCopy, true);
  try {
    return document.execCommand("copy") && wroteClipboardData;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

export function hasTransferableComposerContent(prompt: string, attachmentCount: number): boolean {
  return prompt.length > 0 || attachmentCount > 0;
}

export function stageComposerTransfer(
  prompt: string,
  files: ReadonlyArray<File>,
): StagedComposerTransfer {
  const transfer: StagedComposerTransfer = {
    token: newTransferToken(),
    prompt,
    files: files.map(cloneFile),
  };
  stagedTransfers.set(transfer.token, transfer);
  trimStagedTransfers();
  return transfer;
}

export function discardComposerTransfer(token: string): void {
  stagedTransfers.delete(token);
}

export function composerTransferHtml(transfer: Pick<StagedComposerTransfer, "token" | "prompt">) {
  const promptHtml = escapeHtml(transfer.prompt).replaceAll(/\r?\n/gu, "<br>");
  return `<div data-solla-composer-transfer="${transfer.token}">${promptHtml}</div>`;
}

export async function writeComposerTransferToClipboard(
  transfer: Pick<StagedComposerTransfer, "token" | "prompt">,
): Promise<boolean> {
  const html = composerTransferHtml(transfer);
  if (writeWithCopyEvent({ token: transfer.token, prompt: transfer.prompt, html })) {
    return true;
  }

  const clipboard = globalThis.navigator?.clipboard;
  const ClipboardItemConstructor = globalThis.ClipboardItem;
  if (clipboard && typeof clipboard.write === "function" && ClipboardItemConstructor) {
    try {
      await clipboard.write([
        new ClipboardItemConstructor({
          "text/plain": new Blob([transfer.prompt], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      // HTTP remote clients and stricter browser policies may reject async
      // clipboard writes. The source composer remains untouched when both
      // clipboard paths fail.
    }
  }
  return false;
}

export function readComposerTransferFromClipboard(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerTransfer | null {
  const directToken = clipboardData.getData(COMPOSER_TRANSFER_MIME).trim();
  const token = TRANSFER_TOKEN_PATTERN.test(directToken)
    ? directToken
    : transferTokenFromHtml(clipboardData.getData("text/html"));
  if (!token) return null;

  const transfer = stagedTransfers.get(token);
  if (!transfer) return null;
  return {
    prompt: transfer.prompt,
    files: transfer.files.map(cloneFile),
  };
}
