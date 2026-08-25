export const TERMINAL_PANE_DRAG_MIME = "application/x-t3-terminal-id";
export const TERMINAL_GROUP_DRAG_MIME = "application/x-t3-terminal-group-id";
export const COMPOSER_MENTION_DRAG_MIME = "application/x-t3code-composer-mention";

const INTERNAL_TERMINAL_DRAG_TYPES = [TERMINAL_PANE_DRAG_MIME, TERMINAL_GROUP_DRAG_MIME] as const;

export type TerminalFileDropKind = "ignore" | "accept" | "reject";

export interface TerminalFileDropPreview {
  readonly kind: TerminalFileDropKind;
  readonly title: string;
  readonly description: string;
}

export interface TerminalFileDropCollectInput {
  readonly types: readonly string[];
  readonly files: ReadonlyArray<File>;
  readonly getData: (type: string) => string;
  readonly resolveFilePath?: (file: File) => string | null;
  readonly canResolveOsFilePaths?: boolean;
}

const ACCEPT_FILES: TerminalFileDropPreview = {
  kind: "accept",
  title: "Drop to insert path",
  description: "File paths will be typed into the terminal",
};

const ACCEPT_TEXT: TerminalFileDropPreview = {
  kind: "accept",
  title: "Drop to insert text",
  description: "This will be typed into the terminal",
};

const REJECT_FILES: TerminalFileDropPreview = {
  kind: "reject",
  title: "Can't drop files here",
  description: "File paths are available in the desktop app",
};

const REJECT_OTHER: TerminalFileDropPreview = {
  kind: "reject",
  title: "Can't drop this here",
  description: "Drop files or text to type them into the terminal",
};

const IGNORE: TerminalFileDropPreview = {
  kind: "ignore",
  title: "",
  description: "",
};

export function terminalFileDropPreviewsEqual(
  left: TerminalFileDropPreview | null,
  right: TerminalFileDropPreview | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.kind === right.kind && left.title === right.title && left.description === right.description
  );
}

export function canResolveOsFilePaths(
  bridge:
    | {
        readonly getPathForFile?: (file: File) => string;
      }
    | null
    | undefined = typeof window === "undefined" ? undefined : window.desktopBridge,
): boolean {
  return typeof bridge?.getPathForFile === "function";
}

export function classifyTerminalFileDrop(
  types: readonly string[],
  options?: { readonly canResolveOsFilePaths?: boolean },
): TerminalFileDropPreview {
  if (INTERNAL_TERMINAL_DRAG_TYPES.some((mime) => types.includes(mime))) {
    return IGNORE;
  }
  if (types.includes(COMPOSER_MENTION_DRAG_MIME)) {
    return ACCEPT_FILES;
  }
  const hasFiles = types.includes("Files");
  const hasUriList = types.includes("text/uri-list");
  const hasPlainText = types.includes("text/plain");
  if (hasFiles) {
    if (options?.canResolveOsFilePaths === true || hasUriList) {
      return ACCEPT_FILES;
    }
    return REJECT_FILES;
  }
  if (hasUriList) {
    return ACCEPT_FILES;
  }
  if (hasPlainText) {
    return ACCEPT_TEXT;
  }
  return REJECT_OTHER;
}

export function quoteTerminalPath(value: string): string {
  if (/^[A-Za-z0-9._/~+-]+$/.test(value)) {
    return value;
  }
  if (/^[A-Za-z]:[\\/][A-Za-z0-9._\\/~+-]*$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fileUrlToPath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "file:") {
    return null;
  }
  const host = url.hostname;
  let pathname = decodeURIComponent(url.pathname);
  if (host.length > 0 && host !== "localhost") {
    return `\\\\${host}${pathname.replaceAll("/", "\\")}`;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return pathname;
}

export function pathsFromUriList(uriList: string): string[] {
  const paths: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const path = fileUrlToPath(trimmed);
    if (path !== null && path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

export function pathFromComposerFileLink(serialized: string): string | null {
  const trimmed = serialized.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const markdownLink = trimmed.match(/^\[[^\]]*]\((.*)\)$/s);
  if (markdownLink?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(markdownLink[1]);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return markdownLink[1].length > 0 ? markdownLink[1] : null;
    }
  }
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return trimmed.slice(1);
  }
  return trimmed;
}

export function resolveOsFilePath(
  file: File,
  getPathForFile?: (file: File) => string | null,
): string | null {
  let fromBridge = "";
  try {
    fromBridge = getPathForFile?.(file)?.trim() ?? "";
  } catch {
    // Older or partially loaded desktop preloads can reject cross-world File
    // objects. Fall through to the legacy property and then a visible intake
    // error instead of aborting the drop handler without feedback.
  }
  if (fromBridge.length > 0) {
    return fromBridge;
  }
  const path = (file as File & { path?: unknown }).path;
  if (typeof path === "string" && path.trim().length > 0) {
    return path.trim();
  }
  return null;
}

export function buildTerminalDropInput(input: {
  readonly paths: readonly string[];
  readonly text?: string | null;
}): string | null {
  if (input.paths.length > 0) {
    return `${input.paths.map(quoteTerminalPath).join(" ")} `;
  }
  const text = input.text?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function collectTerminalDropInput(input: TerminalFileDropCollectInput): string | null {
  const preview = classifyTerminalFileDrop(
    input.types,
    input.canResolveOsFilePaths === undefined
      ? undefined
      : { canResolveOsFilePaths: input.canResolveOsFilePaths },
  );
  if (preview.kind !== "accept") {
    return null;
  }

  if (input.types.includes(COMPOSER_MENTION_DRAG_MIME)) {
    const mentionPath = pathFromComposerFileLink(input.getData(COMPOSER_MENTION_DRAG_MIME));
    if (mentionPath !== null) {
      return buildTerminalDropInput({ paths: [mentionPath] });
    }
  }

  const filePaths = uniquePaths(
    input.files.flatMap((file) => {
      const path = resolveOsFilePath(file, input.resolveFilePath);
      return path === null ? [] : [path];
    }),
  );
  if (filePaths.length > 0) {
    return buildTerminalDropInput({ paths: filePaths });
  }

  if (input.types.includes("text/uri-list")) {
    const uriPaths = uniquePaths(pathsFromUriList(input.getData("text/uri-list")));
    if (uriPaths.length > 0) {
      return buildTerminalDropInput({ paths: uriPaths });
    }
    const uriList = input.getData("text/uri-list").trim();
    if (uriList.length > 0 && !uriList.startsWith("#")) {
      const firstUri = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#"));
      if (firstUri) {
        return buildTerminalDropInput({ paths: [], text: firstUri });
      }
    }
  }

  if (input.types.includes("text/plain")) {
    return buildTerminalDropInput({ paths: [], text: input.getData("text/plain") });
  }

  return null;
}
