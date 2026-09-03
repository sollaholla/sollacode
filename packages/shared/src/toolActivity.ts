import type { ToolLifecycleItemType } from "@t3tools/contracts";
import {
  previewComputerControlAction,
  previewComputerControlHeading,
} from "./previewComputerControl.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

const GENERIC_TOOL_TITLES = new Set(["tool", "tool call", "tool_call", "terminal"]);

export function isGenericToolTitle(title: string | null | undefined): boolean {
  const normalized = asTrimmedString(title)?.toLowerCase();
  return normalized === undefined || GENERIC_TOOL_TITLES.has(normalized);
}

function extractDeclaredToolName(data: Record<string, unknown> | undefined): string | undefined {
  const rawInput = asRecord(data?.rawInput);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const meta = asRecord(data?._meta) ?? asRecord(rawInput?._meta);
  const candidates = [
    rawInput?.name,
    rawInput?.tool,
    rawInput?.toolName,
    rawInput?.tool_name,
    rawInput?.function,
    rawInput?.functionName,
    item?.name,
    itemInput?.name,
    meta?.name,
    meta?.toolName,
    data?.name,
    data?.toolName,
  ];
  for (const candidate of candidates) {
    const name = asTrimmedString(candidate);
    if (name && !isGenericToolTitle(name)) {
      return name;
    }
  }
  return undefined;
}

function normalizeToolNameToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function classifyFromToolName(
  name: string | undefined,
): "command" | "read" | "file_change" | "search" | undefined {
  if (!name) {
    return undefined;
  }
  const token = normalizeToolNameToken(name);
  if (/^(bash|shell|zsh|sh|exec|command|run_command|run_terminal_cmd|terminal)$/u.test(token)) {
    return "command";
  }
  if (/(^|_)(read|read_file|view|cat|open)(_|$)/u.test(token) || token === "readfile") {
    return "read";
  }
  if (/(write|edit|str_replace|apply_patch|delete|move|update_file)/u.test(token)) {
    return "file_change";
  }
  if (/(grep|glob|find|search|rg|list_dir|ls|codebase|fetch)/u.test(token)) {
    return "search";
  }
  return undefined;
}

function humanizeToolName(name: string): string {
  const spaced = name.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (spaced.length === 0) {
    return name;
  }
  return spaced.replace(/\b\w/gu, (character) => character.toUpperCase());
}

function looksLikeSearchDetail(detail: string | undefined): boolean {
  return detail !== undefined && /\bfound\s+\d+/iu.test(detail);
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
  readonly command?: string | undefined;
}): "command" | "read" | "file_change" | "search" | "think" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = isGenericToolTitle(input.title)
    ? undefined
    : asTrimmedString(input.title)?.toLowerCase();
  const declaredName = extractDeclaredToolName(input.data);
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (
    itemType === "web_search" ||
    kind === "search" ||
    kind === "fetch" ||
    title === "find" ||
    title === "grep"
  ) {
    return "search";
  }
  if (kind === "think") {
    return "think";
  }
  const namedAction = classifyFromToolName(declaredName) ?? classifyFromToolName(input.title);
  if (namedAction) {
    return namedAction;
  }
  if (input.command) {
    return "command";
  }
  if (looksLikeSearchDetail(input.detail)) {
    return "search";
  }
  if (extractPrimaryPath(input.data)) {
    return "read";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const rawTitle = asTrimmedString(input.title);
  const title = isGenericToolTitle(rawTitle) ? undefined : rawTitle;
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const rawFallback = asTrimmedString(input.fallbackSummary);
  const fallbackSummary = isGenericToolTitle(rawFallback) ? undefined : rawFallback;
  const data = asRecord(input.data);
  const declaredName = extractDeclaredToolName(data);
  const computerControlAction = previewComputerControlAction({
    ...(rawTitle !== undefined ? { toolTitle: rawTitle } : {}),
    ...(declaredName !== undefined && rawTitle === undefined ? { toolTitle: declaredName } : {}),
    toolData: data,
  });
  if (computerControlAction !== null) {
    return { summary: previewComputerControlHeading(computerControlAction) };
  }
  const namedSummary = declaredName ? humanizeToolName(declaredName) : undefined;
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    detail,
    data,
    command,
  });
  const summaryFor = (category: string): string => namedSummary ?? category;

  if (action === "command") {
    return {
      summary: summaryFor("Ran command"),
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    return {
      summary: summaryFor("Read file"),
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "file_change") {
    return {
      summary: summaryFor("Changed files"),
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const rawInput = asRecord(data?.rawInput);
    const query =
      asTrimmedString(rawInput?.query) ??
      asTrimmedString(rawInput?.pattern) ??
      asTrimmedString(rawInput?.searchTerm) ??
      asTrimmedString(rawInput?.glob);
    return {
      summary: summaryFor("Searched files"),
      ...(query ? { detail: query } : !isEquivalent(detail, title) && detail ? { detail } : {}),
    };
  }

  if (action === "think") {
    return {
      summary: summaryFor("Thought"),
    };
  }

  if (namedSummary) {
    return {
      summary: namedSummary,
      ...(detail && !isEquivalent(detail, namedSummary) ? { detail } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary ?? "Tool",
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary ?? "Tool",
  };
}
