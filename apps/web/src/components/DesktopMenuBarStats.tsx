import { useEffect, useMemo, useRef } from "react";

import type { DesktopMenuBarChat, DesktopMenuBarStats } from "@t3tools/contracts";

import { useThreadShells } from "~/state/entities";
import { resolveSidebarV2Status } from "./Sidebar.logic";

const STATUS_ORDER = { waiting: 0, working: 1, paused: 2 } as const;

function menuBarStatus(status: ReturnType<typeof resolveSidebarV2Status>) {
  if (status === "working") return "working";
  if (status === "approval" || status === "input") return "waiting";
  if (status === "failed") return "paused";
  return null;
}

/**
 * Tells the macOS menu bar item what every computer's chats are doing. This
 * window is the one place that knows, and it stays alive while hidden.
 */
export function DesktopMenuBarStats() {
  const threads = useThreadShells();
  const stats = useMemo<DesktopMenuBarStats>(() => {
    const nowMs = Date.now();
    const chats = threads.flatMap((thread): ReadonlyArray<DesktopMenuBarChat> => {
      if (thread.archivedAt) return [];
      const status = menuBarStatus(
        resolveSidebarV2Status(
          {
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            session: thread.session,
            latestTurn: thread.latestTurn,
            pendingWork: thread.pendingWork,
            backgroundTasks: thread.backgroundTasks,
          },
          nowMs,
        ),
      );
      return status === null
        ? []
        : [
            {
              environmentId: thread.environmentId,
              threadId: thread.id,
              title: thread.title,
              status,
            },
          ];
    });
    const count = (status: DesktopMenuBarChat["status"]) =>
      chats.filter((chat) => chat.status === status).length;
    return {
      working: count("working"),
      waiting: count("waiting"),
      paused: count("paused"),
      chats: chats.toSorted((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    };
  }, [threads]);

  const lastPublished = useRef("");
  useEffect(() => {
    const publish = window.desktopBridge?.publishMenuBarStats;
    if (publish === undefined) return;
    const serialized = JSON.stringify(stats);
    if (serialized === lastPublished.current) return;
    lastPublished.current = serialized;
    void publish(stats).catch(() => undefined);
  }, [stats]);

  return null;
}
