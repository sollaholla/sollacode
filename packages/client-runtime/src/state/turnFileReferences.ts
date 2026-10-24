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

/** One candidate a message or activity contributes, in the order it contributes it. */
type SourceReference = readonly [turnId: string, reference: TurnFileReference];

interface SourceReferences {
  readonly cwd: string | undefined;
  readonly references: ReadonlyArray<SourceReference>;
}

const NO_SOURCE_REFERENCES: ReadonlyArray<SourceReference> = [];

// Messages and activities are immutable, and a streaming turn re-collects the
// whole thread on every update; only a changed item has to be scanned again.
const referencesByMessage = new WeakMap<MessageReferenceSource, SourceReferences>();
const referencesByActivity = new WeakMap<ActivityReferenceSource, SourceReferences>();

function cachedSourceReferences<A extends object>(
  cache: WeakMap<A, SourceReferences>,
  source: A,
  cwd: string | undefined,
  collect: (source: A, cwd: string | undefined) => ReadonlyArray<SourceReference>,
): ReadonlyArray<SourceReference> {
  const cached = cache.get(source);
  if (cached !== undefined && cached.cwd === cwd) return cached.references;
  const references = collect(source, cwd);
  cache.set(source, { cwd, references });
  return references;
}

function sourceReferenceCollector(cwd: string | undefined) {
  const references: SourceReference[] = [];
  const add = (
    turnId: string,
    value: string,
    source: Pick<TurnFileReference, "sourceMessageId" | "sourceActivityId">,
  ) => {
    const path = normalizeReference(value, cwd);
    if (!path) return;
    references.push([
      turnId,
      {
        path,
        name: path.split(/[\\/]/).at(-1)?.split(/[?#]/)[0] ?? path,
        kind: referenceKind(path),
        ...source,
      },
    ]);
  };
  return { references, add };
}

function collectMessageReferences(
  message: MessageReferenceSource,
  cwd: string | undefined,
): ReadonlyArray<SourceReference> {
  if (message.role !== "assistant" || !message.turnId) return NO_SOURCE_REFERENCES;
  const { references, add } = sourceReferenceCollector(cwd);
  const text = message.text.slice(0, 200_000).replace(/```[^]*?```/gu, "");
  for (const match of text.matchAll(
    /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/gu,
  )) {
    add(message.turnId, match[1]!, { sourceMessageId: message.id });
  }
  for (const match of text.matchAll(/`([^`\n]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?)`/giu)) {
    add(message.turnId, match[1]!, { sourceMessageId: message.id });
  }
  return references.length === 0 ? NO_SOURCE_REFERENCES : references;
}

function collectActivityReferences(
  activity: ActivityReferenceSource,
  cwd: string | undefined,
): ReadonlyArray<SourceReference> {
  if (!activity.turnId) return NO_SOURCE_REFERENCES;
  const payload = record(activity.payload);
  if (!payload) return NO_SOURCE_REFERENCES;
  const { references, add } = sourceReferenceCollector(cwd);
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
  if (isFileTool) {
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
  return references.length === 0 ? NO_SOURCE_REFERENCES : references;
}

/** File candidates only; the client must confirm them on the owning host before listing them. */
export function collectThreadFileReferencesByTurnId(input: {
  readonly messages: ReadonlyArray<MessageReferenceSource>;
  readonly activities: ReadonlyArray<ActivityReferenceSource>;
  readonly cwd?: string;
}): ReadonlyMap<string, ReadonlyArray<TurnFileReference>> {
  const turns = new Map<string, Map<string, TurnFileReference>>();
  const add = ([turnId, reference]: SourceReference) => {
    let refs = turns.get(turnId);
    if (!refs) {
      refs = new Map();
      turns.set(turnId, refs);
    }
    if (refs.size >= 100 || refs.has(reference.path)) return;
    refs.set(reference.path, reference);
  };
  for (const message of input.messages) {
    for (const reference of cachedSourceReferences(
      referencesByMessage,
      message,
      input.cwd,
      collectMessageReferences,
    )) {
      add(reference);
    }
  }
  for (const activity of input.activities) {
    for (const reference of cachedSourceReferences(
      referencesByActivity,
      activity,
      input.cwd,
      collectActivityReferences,
    )) {
      add(reference);
    }
  }
  return new Map([...turns].map(([turnId, refs]) => [turnId, [...refs.values()]]));
}
