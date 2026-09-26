import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
  readImageToolOutputPath,
} from "@t3tools/shared/filePreview";

export interface TurnFileReference {
  readonly path: string;
  readonly name: string;
  readonly kind: "image" | "video" | "audio" | "document" | "file";
  readonly sourceMessageId?: string;
  readonly sourceActivityId?: string;
}
interface MessageReferenceSource {
  readonly id: string;
  readonly role: string;
  readonly turnId?: string | null;
  readonly text: string;
}
interface ActivityReferenceSource {
  readonly id: string;
  readonly turnId?: string | null;
  readonly payload?: unknown;
}

function referenceKind(path: string): TurnFileReference["kind"] {
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isWorkspaceVideoPreviewPath(path)) return "video";
  if (isWorkspaceAudioPreviewPath(path)) return "audio";
  if (/\.(?:pdf|md|txt|csv|docx?|xlsx?|pptx?)(?:[?#].*)?$/iu.test(path)) return "document";
  return "file";
}
function normalizeReference(value: string, cwd?: string): string | null {
  let path = value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/u, "");
  if (
    !path ||
    path.length > 1024 ||
    ["\r", "\n", String.fromCharCode(0)].some((character) => path.includes(character))
  )
    return null;
  try {
    path = decodeURI(path);
  } catch {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return null;
  path = path.replaceAll("\\", "/");
  if (cwd && !/^(?:\/|[a-z]:\/)/iu.test(path)) path = `${cwd.replaceAll("\\", "/")}/${path}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== ".." && parts.at(-1) !== "") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** File candidates only; the client must confirm them on the owning host before listing them. */
export function collectThreadFileReferencesByTurnId(input: {
  readonly messages: ReadonlyArray<MessageReferenceSource>;
  readonly activities: ReadonlyArray<ActivityReferenceSource>;
  readonly cwd?: string;
}): ReadonlyMap<string, ReadonlyArray<TurnFileReference>> {
  const turns = new Map<string, Map<string, TurnFileReference>>();
  const add = (
    turnId: string,
    value: string,
    source: Pick<TurnFileReference, "sourceMessageId" | "sourceActivityId">,
  ) => {
    const path = normalizeReference(value, input.cwd);
    if (!path) return;
    let refs = turns.get(turnId);
    if (!refs) {
      refs = new Map();
      turns.set(turnId, refs);
    }
    if (refs.size >= 100 || refs.has(path)) return;
    refs.set(path, {
      path,
      name: path.split(/[\\/]/).at(-1)?.split(/[?#]/)[0] ?? path,
      kind: referenceKind(path),
      ...source,
    });
  };
  for (const message of input.messages) {
    if (message.role !== "assistant" || !message.turnId) continue;
    const text = message.text.slice(0, 200_000).replace(/```[^]*?```/gu, "");
    for (const match of text.matchAll(
      /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/gu,
    )) {
      add(message.turnId, match[1]!, { sourceMessageId: message.id });
    }
    for (const match of text.matchAll(/`([^`\n]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?)`/giu)) {
      add(message.turnId, match[1]!, { sourceMessageId: message.id });
    }
  }
  for (const activity of input.activities) {
    if (!activity.turnId) continue;
    const payload = record(activity.payload);
    if (!payload) continue;
    const receiptPath = readImageToolOutputPath(payload);
    if (receiptPath) add(activity.turnId, receiptPath, { sourceActivityId: activity.id });
    const data = record(payload.data);
    const item = record(data?.item);
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    const invocation = /^\s*Read\s*:\s*(\{[^]*\})\s*$/iu.exec(detail);
    let invocationInput: Record<string, unknown> | null = null;
    if (invocation?.[1] && invocation[1].length <= 20_000) {
      try {
        invocationInput = record(JSON.parse(invocation[1]));
      } catch {
        /* Incomplete invocation. */
      }
    }
    const isFileTool =
      ["image_view", "image_generation", "file_read", "file_write"].includes(
        String(payload.itemType),
      ) ||
      payload.requestKind === "file-read" ||
      data?.kind === "read" ||
      /^(?:read|read file|read image|view image|image view)$/iu.test(String(payload.title)) ||
      invocationInput !== null;
    if (!isFileTool) continue;
    for (const obj of [
      payload,
      record(payload.input),
      record(payload.arguments),
      record(payload.output),
      data,
      record(data?.rawInput),
      item,
      record(item?.input),
      record(item?.arguments),
      invocationInput,
    ]) {
      if (!obj) continue;
      for (const key of [
        "path",
        "filePath",
        "file_path",
        "savedPath",
        "saved_path",
        "absolutePath",
        "absolute_path",
      ]) {
        if (typeof obj[key] === "string")
          add(activity.turnId, obj[key], { sourceActivityId: activity.id });
      }
    }
  }
  return new Map([...turns].map(([turnId, refs]) => [turnId, [...refs.values()]]));
}
