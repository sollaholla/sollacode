import { randomUUID } from "~/lib/utils";
import {
  type ComposerTransferPersistence,
  indexedDbComposerTransferPersistence,
  type PersistedComposerTransfer,
} from "./composerTransferPersistence";

const COMPOSER_TRANSFER_MIME = "application/x-solla-composer-transfer";
const MAX_STAGED_TRANSFERS = 8;
const STAGED_TRANSFER_TTL_MS = 30 * 60 * 1000;
const TRANSFER_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{12,160}$/u;
const TRANSFER_METADATA_STORAGE_KEY = "t3code:composer-transfers:v1";

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
type ComposerTransferMetadata = {
  readonly token: string;
  readonly promptFingerprint: string;
  readonly fileCount: number;
  readonly stagedAt: number;
};

type ComposerTransferMetadataDocument = {
  readonly version: 1;
  readonly transfers: ReadonlyArray<ComposerTransferMetadata>;
};

type ComposerTransferMetadataStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let persistenceOverride: ComposerTransferPersistence | null = null;
let metadataStorageOverride: ComposerTransferMetadataStorage | null = null;

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
  return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function clipboardTextFingerprint(value: string): string {
  const normalized = normalizeClipboardText(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second = ((second << 13) | (second >>> 19)) >>> 0;
  }
  return `${normalized.length}:${first.toString(16).padStart(8, "0")}:${second
    .toString(16)
    .padStart(8, "0")}`;
}

function resolveMetadataStorage(): ComposerTransferMetadataStorage | null {
  if (metadataStorageOverride) return metadataStorageOverride;
  try {
    if (
      typeof localStorage !== "undefined" &&
      typeof localStorage.getItem === "function" &&
      typeof localStorage.setItem === "function" &&
      typeof localStorage.removeItem === "function"
    ) {
      return localStorage;
    }
  } catch {
    // Storage access can itself throw in sandboxed or policy-blocked contexts.
  }
  return null;
}

function normalizeTransferMetadata(value: unknown, now = Date.now()): ComposerTransferMetadata[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as Partial<ComposerTransferMetadataDocument>;
  if (candidate.version !== 1 || !Array.isArray(candidate.transfers)) return [];
  return candidate.transfers.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const transfer = raw as Partial<ComposerTransferMetadata>;
    if (
      typeof transfer.token !== "string" ||
      !TRANSFER_TOKEN_PATTERN.test(transfer.token) ||
      typeof transfer.promptFingerprint !== "string" ||
      typeof transfer.fileCount !== "number" ||
      !Number.isInteger(transfer.fileCount) ||
      transfer.fileCount <= 0 ||
      typeof transfer.stagedAt !== "number" ||
      !Number.isFinite(transfer.stagedAt) ||
      now - transfer.stagedAt > STAGED_TRANSFER_TTL_MS
    ) {
      return [];
    }
    return [
      {
        token: transfer.token,
        promptFingerprint: transfer.promptFingerprint,
        fileCount: transfer.fileCount,
        stagedAt: transfer.stagedAt,
      },
    ];
  });
}

function readTransferMetadata(): ComposerTransferMetadata[] {
  const storage = resolveMetadataStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(TRANSFER_METADATA_STORAGE_KEY);
    if (!raw) return [];
    return normalizeTransferMetadata(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeTransferMetadata(transfers: ReadonlyArray<ComposerTransferMetadata>): boolean {
  const storage = resolveMetadataStorage();
  if (!storage) return false;
  try {
    if (transfers.length === 0) {
      storage.removeItem(TRANSFER_METADATA_STORAGE_KEY);
    } else {
      storage.setItem(
        TRANSFER_METADATA_STORAGE_KEY,
        JSON.stringify({ version: 1, transfers } satisfies ComposerTransferMetadataDocument),
      );
    }
    return true;
  } catch {
    return false;
  }
}

function currentPersistence(): ComposerTransferPersistence {
  return persistenceOverride ?? indexedDbComposerTransferPersistence;
}

function safeClipboardData(clipboardData: Pick<DataTransfer, "getData">, type: string): string {
  try {
    return clipboardData.getData(type);
  } catch {
    return "";
  }
}

function persistedTransferCandidate(input: {
  readonly directToken: string;
  readonly html: string;
  readonly plainText: string;
}): { readonly metadata: ComposerTransferMetadata; readonly matchedByPlainText: boolean } | null {
  const markerToken = TRANSFER_TOKEN_PATTERN.test(input.directToken)
    ? input.directToken
    : transferTokenFromHtml(input.html);
  const metadata = readTransferMetadata();
  if (markerToken) {
    const directMatch = metadata.find((transfer) => transfer.token === markerToken);
    return directMatch ? { metadata: directMatch, matchedByPlainText: false } : null;
  }
  const fingerprint = clipboardTextFingerprint(input.plainText);
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const candidate = metadata[index];
    if (candidate?.promptFingerprint === fingerprint) {
      return { metadata: candidate, matchedByPlainText: true };
    }
  }
  return null;
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
  const nextMetadata = readTransferMetadata().filter((transfer) => transfer.token !== token);
  writeTransferMetadata(nextMetadata);
  void currentPersistence()
    .remove(token)
    .catch(() => undefined);
}

/**
 * Commits every attachment to IndexedDB before the source composer is cleared.
 * The small localStorage record contains only a text fingerprint and token;
 * image bytes stay in IndexedDB, where large multi-image drafts fit without
 * consuming the origin's small localStorage quota.
 */
export async function persistComposerTransfer(transfer: StagedComposerTransfer): Promise<boolean> {
  if (transfer.files.length === 0) return true;
  const persisted: PersistedComposerTransfer = {
    token: transfer.token,
    prompt: transfer.prompt,
    stagedAt: transfer.stagedAt,
    files: transfer.files.map((file) => ({
      name: file.name,
      mimeType: file.type,
      lastModified: file.lastModified,
      blob: file,
    })),
  };
  try {
    await currentPersistence().write(persisted);
    const existing = readTransferMetadata().filter((entry) => entry.token !== transfer.token);
    const next = [
      ...existing,
      {
        token: transfer.token,
        promptFingerprint: clipboardTextFingerprint(transfer.prompt),
        fileCount: transfer.files.length,
        stagedAt: transfer.stagedAt,
      },
    ].slice(-MAX_STAGED_TRANSFERS);
    if (!writeTransferMetadata(next)) {
      await currentPersistence()
        .remove(transfer.token)
        .catch(() => undefined);
      return false;
    }
    const retainedTokens = new Set(next.map((entry) => entry.token));
    for (const entry of existing) {
      if (!retainedTokens.has(entry.token)) {
        void currentPersistence()
          .remove(entry.token)
          .catch(() => undefined);
      }
    }
    return true;
  } catch {
    return false;
  }
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

  // The desktop bridge uses Electron's atomic clipboard.write({ text, html,
  // image }). Chromium's async ClipboardItem route can report success on macOS
  // while leaving only the image on the native pasteboard, which removes the
  // marker needed to restore the complete cut.
  if (firstImage) {
    const png = await toPngBlob(firstImage);
    if (png) {
      const desktopWrite =
        typeof window === "undefined" ? undefined : window.desktopBridge?.writeComposerClipboard;
      if (desktopWrite) {
        try {
          return await desktopWrite({
            text: transfer.prompt,
            html,
            imagePng: new Uint8Array(await png.arrayBuffer()),
          });
        } catch {
          // Never clear an image draft after a failed native write. Unlike the
          // string-only fallbacks below, this route promises the real bitmap.
          return false;
        }
      }

      // Browser and remote clients do not have the desktop bridge. Their best
      // available route is the standards-based async clipboard API.
      if (!clipboard || typeof clipboard.write !== "function" || !ClipboardItemConstructor) {
        return false;
      }
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
        return false;
      }
    }

    // A non-PNG source that cannot be decoded cannot be represented safely on
    // the system clipboard. Keep the draft intact instead of copying only text.
    return false;
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

/**
 * Reads native file entries from a paste event without assuming Chromium put
 * them in `DataTransfer.files`. On macOS and Windows clipboard files may be
 * exposed only as file-kind `items`, even though a normal file drop populates
 * both collections.
 *
 * Preserve native File objects whenever possible. Electron's
 * `webUtils.getPathForFile` can resolve a disk-backed File, but a reconstructed
 * copy no longer carries that backing path.
 */
export function readClipboardFiles(clipboardData: Pick<DataTransfer, "files" | "items">): File[] {
  let files: File[] = [];
  try {
    files = Array.from(clipboardData.files);
  } catch {
    // Some synthetic and restricted clipboard objects throw while enumerating.
  }
  if (files.length > 0) return files;

  try {
    return Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return [];
      const declaredType = item.type.toLowerCase();
      const file = item.getAsFile();
      if (!file) return [];
      if (!declaredType.startsWith("image/") || file.type.startsWith("image/")) return [file];
      return [
        new File([file], file.name || "clipboard-image", {
          type: declaredType,
          lastModified: file.lastModified,
        }),
      ];
    });
  } catch {
    return [];
  }
}

export function readComposerTransferFromClipboard(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerTransfer | null {
  const directToken = safeClipboardData(clipboardData, COMPOSER_TRANSFER_MIME).trim();
  const token = TRANSFER_TOKEN_PATTERN.test(directToken)
    ? directToken
    : transferTokenFromHtml(safeClipboardData(clipboardData, "text/html"));
  trimStagedTransfers();
  const transfer = token
    ? (stagedTransfers.get(token) ?? null)
    : latestTransferMatchingPlainText(safeClipboardData(clipboardData, "text/plain"));
  if (!transfer) return null;
  return {
    prompt: transfer.prompt,
    files: transfer.files.map(cloneFile),
  };
}

/** True when paste must be held while an IndexedDB transfer is restored. */
export function hasPersistedComposerTransfer(
  clipboardData: Pick<DataTransfer, "getData">,
): boolean {
  return (
    persistedTransferCandidate({
      directToken: safeClipboardData(clipboardData, COMPOSER_TRANSFER_MIME).trim(),
      html: safeClipboardData(clipboardData, "text/html"),
      plainText: safeClipboardData(clipboardData, "text/plain"),
    }) !== null
  );
}

/**
 * Restores a transfer after a renderer reload or from another same-origin
 * Solla window. Clipboard strings are captured before the first await because
 * browser clipboard event objects are only guaranteed during the event turn.
 */
export async function resolveComposerTransferFromClipboard(
  clipboardData: Pick<DataTransfer, "getData">,
): Promise<ComposerTransfer | null> {
  const inMemory = readComposerTransferFromClipboard(clipboardData);
  if (inMemory) return inMemory;

  const plainText = safeClipboardData(clipboardData, "text/plain");
  const candidate = persistedTransferCandidate({
    directToken: safeClipboardData(clipboardData, COMPOSER_TRANSFER_MIME).trim(),
    html: safeClipboardData(clipboardData, "text/html"),
    plainText,
  });
  if (!candidate) return null;

  try {
    const persisted = await currentPersistence().read(candidate.metadata.token);
    if (!persisted || Date.now() - persisted.stagedAt > STAGED_TRANSFER_TTL_MS) {
      discardComposerTransfer(candidate.metadata.token);
      return null;
    }
    if (
      candidate.matchedByPlainText &&
      normalizeClipboardText(persisted.prompt) !== normalizeClipboardText(plainText)
    ) {
      return null;
    }
    const transfer: StagedComposerTransfer = {
      token: persisted.token,
      prompt: persisted.prompt,
      stagedAt: persisted.stagedAt,
      files: persisted.files.map(
        (file) =>
          new File([file.blob], file.name, {
            type: file.mimeType,
            lastModified: file.lastModified,
          }),
      ),
    };
    if (transfer.files.length !== candidate.metadata.fileCount) return null;
    stagedTransfers.set(transfer.token, transfer);
    trimStagedTransfers();
    return {
      prompt: transfer.prompt,
      files: transfer.files.map(cloneFile),
    };
  } catch {
    return null;
  }
}

/** Test seam for simulating a fresh renderer without depending on real IndexedDB. */
export function setComposerTransferPersistenceForTest(input: {
  readonly persistence: ComposerTransferPersistence | null;
  readonly metadataStorage: ComposerTransferMetadataStorage | null;
}): void {
  persistenceOverride = input.persistence;
  metadataStorageOverride = input.metadataStorage;
}

export function clearInMemoryComposerTransfersForTest(): void {
  stagedTransfers.clear();
}

/**
 * Decides what a paste should insert.
 *
 * Three routes converge here and only one may win, or the draft is duplicated:
 *  - a resolved staged transfer restores the whole draft at full fidelity;
 *  - otherwise clipboard files plus their accompanying text are inserted
 *    together; images upload while disk-backed non-images become path refs;
 *  - with no files at all the browser's own paste is left alone.
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
  if (input.clipboardFiles.length === 0) {
    return { handled: false, prompt: null, files: [] };
  }
  return {
    handled: true,
    prompt: input.clipboardText.length > 0 ? input.clipboardText : null,
    files: input.clipboardFiles,
  };
}
