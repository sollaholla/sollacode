/**
 * Persisted per-thread terminal layout — the server-authoritative pane
 * topology (groups, split trees, names, ordering) every client renders.
 * One `.layout.json` per thread beside the terminal history logs; written
 * on each accepted `terminal.setLayout` and loaded at boot so the workspace
 * arrangement survives server restarts the same way sessions do.
 */
import {
  type TerminalLayoutGroup,
  type TerminalPaneNode,
  TerminalThreadLayout,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const TERMINAL_THREAD_LAYOUT_SUFFIX = ".layout.json";

export function threadLayoutFilePath(historyLogPath: string): string {
  return historyLogPath.endsWith(".log")
    ? `${historyLogPath.slice(0, -".log".length)}${TERMINAL_THREAD_LAYOUT_SUFFIX}`
    : `${historyLogPath}${TERMINAL_THREAD_LAYOUT_SUFFIX}`;
}

export function isThreadLayoutFileName(name: string): boolean {
  return name.endsWith(TERMINAL_THREAD_LAYOUT_SUFFIX);
}

export function encodeTerminalThreadLayout(layout: TerminalThreadLayout): string {
  return `${JSON.stringify(layout)}\n`;
}

const decodeThreadLayoutOption = Schema.decodeUnknownOption(TerminalThreadLayout);

export function parseTerminalThreadLayout(raw: string): TerminalThreadLayout | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return Option.getOrNull(decodeThreadLayoutOption(value));
}

function paneTerminalIds(node: TerminalPaneNode): string[] {
  if (node.kind === "terminal") {
    return [node.terminalId];
  }
  return node.children.flatMap(paneTerminalIds);
}

function prunePaneNode(
  node: TerminalPaneNode,
  validTerminalIds: ReadonlySet<string>,
  seenTerminalIds: Set<string>,
): TerminalPaneNode | null {
  if (node.kind === "terminal") {
    if (!validTerminalIds.has(node.terminalId) || seenTerminalIds.has(node.terminalId)) {
      return null;
    }
    seenTerminalIds.add(node.terminalId);
    return { kind: "terminal", terminalId: node.terminalId };
  }

  const children = node.children
    .map((child) => prunePaneNode(child, validTerminalIds, seenTerminalIds))
    .filter((child): child is TerminalPaneNode => child !== null);
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0]!;
  }
  return {
    kind: "split",
    direction: node.direction,
    children,
    ...(children.length === node.children.length && node.sizes ? { sizes: [...node.sizes] } : {}),
  };
}

function normalizedGroupLayout(
  layout: TerminalPaneNode | undefined,
  terminalIds: ReadonlyArray<string>,
): TerminalPaneNode | undefined {
  if (terminalIds.length < 2) {
    return undefined;
  }

  const pruned = layout ? prunePaneNode(layout, new Set(terminalIds), new Set<string>()) : null;
  const coveredTerminalIds = new Set(pruned ? paneTerminalIds(pruned) : []);
  const missingTerminalIds = terminalIds.filter(
    (terminalId) => !coveredTerminalIds.has(terminalId),
  );
  const missingLeaves = missingTerminalIds.map(
    (terminalId): TerminalPaneNode => ({ kind: "terminal", terminalId }),
  );

  if (pruned === null) {
    return {
      kind: "split",
      direction: "horizontal",
      children: missingLeaves,
    };
  }
  if (missingLeaves.length === 0) {
    return pruned;
  }
  if (pruned.kind === "split") {
    return {
      kind: "split",
      direction: pruned.direction,
      children: [...pruned.children, ...missingLeaves],
    };
  }
  return {
    kind: "split",
    direction: "horizontal",
    children: [pruned, ...missingLeaves],
  };
}

function uniqueTerminalIds(terminalIds: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  return terminalIds.filter((terminalId) => {
    if (seen.has(terminalId)) {
      return false;
    }
    seen.add(terminalId);
    return true;
  });
}

function uniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let groupId = baseId;
  let suffix = 2;
  while (usedGroupIds.has(groupId)) {
    groupId = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedGroupIds.add(groupId);
  return groupId;
}

/** Terminal ids represented by a saved layout, in stable group order. */
export function terminalIdsInThreadLayout(groups: ReadonlyArray<TerminalLayoutGroup>): string[] {
  return uniqueTerminalIds(groups.flatMap((group) => group.terminalIds));
}

/**
 * Reconciles a saved pane document with the server's terminal inventory.
 * Surviving panes retain their topology; closed panes are pruned and newly
 * opened sessions receive a deterministic group until a client publishes a
 * more specific arrangement.
 */
export function reconcileTerminalThreadLayoutGroups(
  groups: ReadonlyArray<TerminalLayoutGroup>,
  terminalIds: ReadonlyArray<string>,
): ReadonlyArray<TerminalLayoutGroup> {
  const orderedTerminalIds = uniqueTerminalIds(terminalIds);
  const validTerminalIds = new Set(orderedTerminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const nextGroups: TerminalLayoutGroup[] = [];

  for (const group of groups) {
    const groupTerminalIds = uniqueTerminalIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIds.has(terminalId) || assignedTerminalIds.has(terminalId)) {
        return false;
      }
      assignedTerminalIds.add(terminalId);
      return true;
    });
    if (groupTerminalIds.length === 0) {
      continue;
    }
    const layout = normalizedGroupLayout(group.layout, groupTerminalIds);
    nextGroups.push({
      id: uniqueGroupId(group.id, usedGroupIds),
      ...(group.name !== undefined ? { name: group.name } : {}),
      terminalIds: layout ? paneTerminalIds(layout) : groupTerminalIds,
      ...(layout ? { layout } : {}),
    });
  }

  for (const terminalId of orderedTerminalIds) {
    if (assignedTerminalIds.has(terminalId)) {
      continue;
    }
    nextGroups.push({
      id: uniqueGroupId(`group-${terminalId}`, usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return JSON.stringify(nextGroups) === JSON.stringify(groups) ? groups : nextGroups;
}
