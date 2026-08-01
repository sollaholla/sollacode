import { randomUUID } from "~/lib/utils";

const COMPOSER_TRANSFER_MIME = "application/x-solla-composer-transfer";
const MAX_STAGED_TRANSFERS = 8;
const STAGED_TRANSFER_TTL_MS = 30 * 60 * 1000;
const TRANSFER_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{12,160}$/u;

type StagedComposerTransfer = {
  readonly token: string;
  readonly prompt: string;
  readonly files: ReadonlyArray<File>;
  readonly stagedAt: number;
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

function trimStagedTransfers(now = Date.now()): void {
  for (const [token, transfer] of stagedTransfers) {
    if (now - transfer.stagedAt <= STAGED_TRANSFER_TTL_MS) continue;
    stagedTransfers.delete(token);
  }
  while (stagedTransfers.size > MAX_STAGED_TRANSFERS) {
    const oldestToken = stagedTransfers.keys().next().value;
    if (typeof oldestToken !== "string") return;
    stagedTransfers.delete(oldestToken);
  }
}

function normalizeClipboardText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function latestTransferMatchingPlainText(plainText: string): StagedComposerTransfer | null {
  trimStagedTransfers();
  const normalizedPlainText = normalizeClipboardText(plainText);
  const transfers = Array.from(stagedTransfers.values());
  for (let index = transfers.length - 1; index >= 0; index -= 1) {
    const transfer = transfers[index];
    if (!transfer || transfer.files.length === 0) continue;
    if (normalizeClipboardText(transfer.prompt) === normalizedPlainText) return transfer;
  }
  return null;
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
    stagedAt: Date.now(),
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

/**
 * Re-encodes an image as PNG, the only image type Chromium reliably accepts on
 * the system clipboard. Returns null when the image cannot be decoded.
 */
async function toPngBlob(file: File): Promise<Blob | null> {
  if (file.type === "image/png") return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  } catch {
    return null;
  }
}

/**
 * Puts the draft on the system clipboard.
 *
 * Two routes, because neither alone is sufficient:
 *
 *  - The token in `text/html` (and a custom MIME) lets a paste inside this app
 *    recover the *entire* staged draft — every image, at original fidelity.
 *  - Real PNG bytes make the images survive even when the OS or the receiving
 *    surface strips those markers, which is what left cut pasting text only.
 *
 * Only the first image can ride along as bytes: the clipboard holds a single
 * image, so multi-image fidelity still depends on the token surviving.
 */
export async function writeComposerTransferToClipboard(
  transfer: Pick<StagedComposerTransfer, "token" | "prompt">,
  images: ReadonlyArray<File> = [],
): Promise<boolean> {
  const html = composerTransferHtml(transfer);
  const clipboard = globalThis.navigator?.clipboard;
  const ClipboardItemConstructor = globalThis.ClipboardItem;
  const firstImage = images.find((file) => file.type.startsWith("image/"));

  // Image drafts prefer the async API because the synchronous copy event cannot
  // carry binary data. The token still travels in `text/html`.
  if (
    firstImage &&
    clipboard &&
    typeof clipboard.write === "function" &&
    ClipboardItemConstructor
  ) {
    const png = await toPngBlob(firstImage);
    if (png) {
      try {
        await clipboard.write([
          new ClipboardItemConstructor({
            "text/plain": new Blob([transfer.prompt], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
            "image/png": png,
          }),
        ]);
        return true;
      } catch {
        // Fall through: a rejected write must not lose the draft entirely.
      }
    }
  }

  if (writeWithCopyEvent({ token: transfer.token, prompt: transfer.prompt, html })) {
    return true;
  }

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
  trimStagedTransfers();
  const transfer = token
    ? (stagedTransfers.get(token) ?? null)
    : latestTransferMatchingPlainText(clipboardData.getData("text/plain"));
  if (!transfer) return null;
  return {
    prompt: transfer.prompt,
    files: transfer.files.map(cloneFile),
  };
}

/**
 * Decides what a paste should insert.
 *
 * Three routes converge here and only one may win, or the draft is duplicated:
 *  - a resolved staged transfer restores the whole draft at full fidelity;
 *  - otherwise clipboard image bytes plus their accompanying text are inserted
 *    together, which is what a cut produces once the token has been stripped;
 *  - with no images at all the browser's own paste is left alone.
 */
export function planComposerPaste(input: {
  readonly transfer: ComposerTransfer | null;
  readonly clipboardText: string;
  readonly clipboardFiles: ReadonlyArray<File>;
}): {
  readonly handled: boolean;
  readonly prompt: string | null;
  readonly files: ReadonlyArray<File>;
} {
  if (input.transfer) {
    // The staged draft already contains every image, so clipboard bytes for the
    // same cut must be ignored rather than added a second time.
    return {
      handled: true,
      prompt: input.transfer.prompt.length > 0 ? input.transfer.prompt : null,
      files: input.transfer.files,
    };
  }
  const images = input.clipboardFiles.filter((file) => file.type.startsWith("image/"));
  if (images.length === 0) {
    return { handled: false, prompt: null, files: [] };
  }
  return {
    handled: true,
    prompt: input.clipboardText.length > 0 ? input.clipboardText : null,
    files: images,
  };
}
