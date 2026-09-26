/**
 * Bare absolute paths in chat prose.
 *
 * Assistants routinely write `/Users/me/project/report.png` as plain text —
 * no markdown link, no code span — and the renderer used to leave it inert.
 * This finds those mentions so they can become the same clickable file chips
 * a `[report.png](/Users/me/project/report.png)` link gets. Detection is
 * deliberately narrow: an absolute path (POSIX or Windows drive) whose last
 * segment ends in a real extension, optionally followed by `:line[:col]`.
 * Version numbers (`/v1.2`), URLs (`https://host/a.png`), and extensionless
 * paths never match. Whether a match is *real* is not decided here: the
 * caller confirms it against the host (see `hostPathExistence`) before the
 * remark plugin below turns it into a link.
 */
export interface BareFilePathMatch {
  /** Offset of the first character of the match in the source text. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
  /** The whole mention, position suffix included — what the link carries. */
  readonly href: string;
  /** The filesystem path alone — what the host is asked about. */
  readonly path: string;
}

// The last segment must end in `.ext` where ext is 1–8 alphanumerics with at
// least one letter; `(?![\w/])` stops `/a.png/b` from yielding `/a.png` and
// a bare-word lookbehind keeps URL path components (`host/a.png`) out.
const POSIX_BARE_PATH_PATTERN =
  /(?<![\w./\\:@~-])\/(?:[^\s/\\`'"<>()[\]{}|:*?,;]+\/)*[^\s/\\`'"<>()[\]{}|:*?,;]+\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}(:\d+(?::\d+)?)?(?![\w/])/g;
const WINDOWS_BARE_PATH_PATTERN =
  /(?<![\w\\/:.-])[A-Za-z]:\\(?:[^\s\\/`'"<>()[\]{}|:*?,;]+\\)*[^\s\\/`'"<>()[\]{}|:*?,;]+\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}(:\d+(?::\d+)?)?(?![\w\\/])/g;

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export function findBareFilePaths(text: string): BareFilePathMatch[] {
  if (!text.includes("/") && !text.includes(":\\")) return [];
  const matches: BareFilePathMatch[] = [];
  for (const pattern of [POSIX_BARE_PATH_PATTERN, WINDOWS_BARE_PATH_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const href = match[0];
      matches.push({
        start: match.index,
        end: match.index + href.length,
        href,
        path: href.replace(POSITION_SUFFIX_PATTERN, ""),
      });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** The distinct filesystem paths a text mentions, in first-seen order. */
export function uniqueBareFilePaths(matches: ReadonlyArray<BareFilePathMatch>): string[] {
  return [...new Set(matches.map((match) => match.path))];
}

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const EXCLUDED_ANCESTORS = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
  "image",
  "imageReference",
]);

/**
 * remark plugin: turn verified bare paths in text nodes into links.
 *
 * Only paths in `verified` (the host said they exist) are converted; the
 * resulting `link` nodes flow through the same renderer as authored markdown
 * links, so they get the file chip, the click behaviour and the viewer href
 * for free. Text inside code, links and raw HTML is left alone.
 */
export function remarkBareFilePaths(options: { readonly verified: ReadonlySet<string> }) {
  const verified = options.verified;
  return (tree: MarkdownNode) => {
    if (verified.size === 0) return;
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          if (child.type === undefined || !EXCLUDED_ANCESTORS.has(child.type)) visit(child);
          return [child];
        }
        const value = child.value;
        const matches = findBareFilePaths(value).filter((match) => verified.has(match.path));
        if (matches.length === 0) return [child];
        const segments: MarkdownNode[] = [];
        let cursor = 0;
        for (const match of matches) {
          if (match.start > cursor) {
            segments.push({ type: "text", value: value.slice(cursor, match.start) });
          }
          segments.push({
            type: "link",
            url: match.href,
            children: [{ type: "text", value: match.href }],
          });
          cursor = match.end;
        }
        if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
        return segments;
      });
    };
    visit(tree);
  };
}
