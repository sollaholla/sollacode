/** Chromium's PDF viewer exposes almost no DOM text; the AX tree has the page. */
export function isPdfPreviewDocument(input: {
  readonly url: string;
  readonly title: string;
  readonly contentType?: string | undefined;
}): boolean {
  const contentType = input.contentType?.toLowerCase() ?? "";
  if (contentType.includes("pdf")) return true;
  const url = input.url.toLowerCase();
  if (url.includes("application/pdf")) return true;
  try {
    const path = new URL(input.url).pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
  } catch {
    if (/\.pdf(?:$|[?#])/iu.test(url)) return true;
  }
  return /\.pdf\b/iu.test(input.title);
}

const PRIMARY_TEXT_ROLES = new Set(["StaticText", "text", "InlineTextBox", "PDFStaticText"]);
const FALLBACK_TEXT_ROLES = new Set([
  "paragraph",
  "heading",
  "Heading",
  "cell",
  "listitem",
  "ListItem",
]);
const SKIP_NAME_ROLES = new Set([
  "RootWebArea",
  "WebArea",
  "generic",
  "none",
  "Iframe",
  "iframe",
  "pdfViewer",
  "document",
]);

export function collectFrameIdsFromTree(tree: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("frameTree" in record) {
      visit(record.frameTree);
      return;
    }
    const frame = record.frame;
    if (frame !== null && typeof frame === "object" && "id" in frame) {
      const id = (frame as { id: unknown }).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    const children = record.childFrames;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  visit(tree);
  return ids;
}

export function mergeAccessibilityTrees(trees: ReadonlyArray<unknown>): { nodes: unknown[] } {
  const nodes: unknown[] = [];
  for (const tree of trees) {
    if (tree !== null && typeof tree === "object" && "nodes" in tree) {
      const list = (tree as { nodes: unknown }).nodes;
      if (Array.isArray(list)) {
        nodes.push(...list);
        continue;
      }
    }
    if (tree !== undefined) nodes.push(tree);
  }
  return { nodes };
}

export function visibleTextFromAccessibilityTree(tree: unknown, maxLength: number): string {
  const names: string[] = [];
  const visit = (node: unknown, accept: (role: string, name: string) => boolean) => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.ignored === true) {
      // Still walk children: Chromium marks uninteresting parents ignored.
    } else {
      const role = accessibilityRole(record.role);
      const name = accessibilityName(record);
      if (name.length > 0 && accept(role, name)) names.push(name);
    }
    if (Array.isArray(record.nodes)) {
      for (const child of record.nodes) visit(child, accept);
    }
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child, accept);
    }
  };
  visit(tree, (role) => PRIMARY_TEXT_ROLES.has(role));
  if (names.length === 0) {
    visit(tree, (role) => FALLBACK_TEXT_ROLES.has(role));
  }
  if (names.length === 0) {
    visit(tree, (role) => !SKIP_NAME_ROLES.has(role));
  }
  return names.join(" ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function accessibilityRole(role: unknown): string {
  if (typeof role === "string") return role;
  if (role !== null && typeof role === "object" && "value" in role) {
    const value = (role as { value: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function accessibilityName(record: Record<string, unknown>): string {
  const name = record.name;
  if (typeof name === "string") return name.trim();
  if (name !== null && typeof name === "object" && "value" in name) {
    const value = (name as { value: unknown }).value;
    return typeof value === "string" ? value.trim() : "";
  }
  return "";
}
