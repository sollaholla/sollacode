import type { DesktopMenuBarChat, DesktopMenuBarStats } from "@t3tools/contracts";

/** How many chats the menu names; the counts above them still cover the rest. */
const MAX_LISTED_CHATS = 8;
const MAX_TITLE_CHARS = 48;

export const EMPTY_MENU_BAR_STATS: DesktopMenuBarStats = {
  working: 0,
  waiting: 0,
  paused: 0,
  chats: [],
};

export interface MenuBarLine {
  readonly label: string;
  /** Set on a chat row, which opens that chat. */
  readonly chat?: DesktopMenuBarChat;
}

/** One line for the top of the menu. */
export function menuBarSummary(stats: DesktopMenuBarStats): string {
  const parts = [
    stats.working > 0 ? `${stats.working} working` : null,
    stats.waiting > 0 ? `${stats.waiting} waiting on you` : null,
    stats.paused > 0 ? `${stats.paused} paused` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing running" : parts.join(" · ");
}

function chatLabel(chat: DesktopMenuBarChat): string {
  const title =
    chat.title.length > MAX_TITLE_CHARS
      ? `${chat.title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
      : chat.title;
  switch (chat.status) {
    case "working":
      return `▶  ${title}`;
    case "waiting":
      return `●  ${title}`;
    case "paused":
      return `❙❙  ${title}`;
  }
}

export function menuBarChatLines(stats: DesktopMenuBarStats): ReadonlyArray<MenuBarLine> {
  const lines = stats.chats
    .slice(0, MAX_LISTED_CHATS)
    .map((chat) => ({ label: chatLabel(chat), chat }));
  const hidden = stats.chats.length - lines.length;
  return hidden > 0 ? [...lines, { label: `and ${hidden} more` }] : lines;
}

/** The count beside the icon: work in motion, or nothing at all. */
export function menuBarTitle(stats: DesktopMenuBarStats): string {
  return stats.working > 0 ? String(stats.working) : "";
}

function formatMemory(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1 ? `${gigabytes.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The app's own footprint, read each time the menu opens. */
export function menuBarResources(input: {
  readonly memoryBytes: number;
  readonly cpuPercent: number;
  readonly uptimeSeconds: number;
}): string {
  return [
    `${formatMemory(input.memoryBytes)} memory`,
    `${Math.round(input.cpuPercent)}% CPU`,
    `up ${formatUptime(input.uptimeSeconds)}`,
  ].join(" · ");
}

/** The menu action a chat row sends to the app window. */
export function openThreadMenuAction(chat: DesktopMenuBarChat): string {
  return `open-thread:${chat.environmentId}/${chat.threadId}`;
}
