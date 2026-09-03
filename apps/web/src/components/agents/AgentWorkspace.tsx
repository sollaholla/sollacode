import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type VmAgent, VmAgentId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  GitForkIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  ScrollTextIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { RemoteConnectionControl } from "../remoteControl/RemoteConnectionControl";
import { useThreadPreviewState } from "../../previewStateStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { AgentChatSurface } from "./AgentChatSurface";
import { AgentGlyph } from "./AgentGlyph";
import { AgentPowerToggle } from "./AgentPowerToggle";
import { AgentCollaborationPanel } from "./AgentCollaborationPanel";
import { AgentRulesPanel } from "./AgentRulesPanel";
import { AgentAttentionStack } from "./AgentAttentionStack";
import { resolveInlineAgentAttention, resolveInlineAgentNotification } from "./agentNotifications";
import { hasAgentDashboard } from "./agentWorkspaceNavigation";
import { pruneWaitingOnYouAttachment } from "./waitingOnYouAttachment";
import { AgentArtifactPanel, AgentTasksPanel } from "./AgentWorkspacePanels";

export type AgentWorkspaceView = "chat" | "activity" | "tasks" | "dashboard" | "rules";

const VIEW_LABELS: Record<AgentWorkspaceView, string> = {
  chat: "Chat",
  activity: "Activity",
  tasks: "Scheduled work",
  dashboard: "Dashboard",
  rules: "Rules",
};

/**
 * The full surface for one agent: its single-thread chat (the real {@link
 * ChatView} — model picker, effort, usage, everything). The agent's browser is
 * the chat's collaborative preview panel, so the chat IS the workspace;
 * contextual history and settings stay behind one compact tools menu.
 */
export function AgentWorkspace(props: {
  readonly agentId: string;
  readonly environmentId?: EnvironmentId | null;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  if (!environmentId) {
    return <CenteredNote text="Connect an environment to use agents." />;
  }
  return <AgentWorkspaceResolved agentId={props.agentId} environmentId={environmentId} />;
}

function AgentWorkspaceResolved(props: {
  readonly agentId: string;
  readonly environmentId: EnvironmentId;
}) {
  const { environmentId } = props;
  const [view, setView] = useState<AgentWorkspaceView>("chat");

  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId, input: {} }),
    [environmentId],
  );
  const result = useAtomValue(agentsAtom);
  const registryUnavailable = AsyncResult.isFailure(result);
  const latest = Option.getOrNull(AsyncResult.value(result));
  const registrySnapshot = latest && latest.type === "snapshot" ? latest : null;
  const agents: ReadonlyArray<VmAgent> = registrySnapshot?.agents ?? [];
  const agent = agents.find((candidate) => candidate.vmAgentId === props.agentId) ?? null;
  const workspaceAtom = useMemo(
    () =>
      vmAgentEnvironment.workspace({
        environmentId,
        input: { vmAgentId: VmAgentId.make(props.agentId) },
      }),
    [environmentId, props.agentId],
  );
  const workspaceResult = useAtomValue(workspaceAtom);
  const workspaceItem = Option.getOrNull(AsyncResult.value(workspaceResult));
  const workspace = workspaceItem?.type === "snapshot" ? workspaceItem : null;
  const agentKey = `${environmentId}:${props.agentId}`;
  const [revealedNotification, setRevealedNotification] = useState<{
    readonly agentKey: string;
    readonly notificationId: string | null;
  }>({ agentKey, notificationId: null });
  useEffect(() => {
    if (view !== "chat" || workspace === null) return;
    setRevealedNotification((current) => {
      const currentId = current.agentKey === agentKey ? current.notificationId : null;
      const next = resolveInlineAgentNotification(workspace.notifications, currentId);
      const nextId = next?.notificationId ?? null;
      if (current.agentKey === agentKey && current.notificationId === nextId) return current;
      return { agentKey, notificationId: nextId };
    });
  }, [agentKey, view, workspace]);
  const inlineNotification =
    revealedNotification.agentKey === agentKey
      ? (workspace?.notifications.find(
          (notification) => notification.notificationId === revealedNotification.notificationId,
        ) ?? null)
      : null;
  const inlineAttention = useMemo(
    () => resolveInlineAgentAttention(workspace?.blockers ?? [], inlineNotification),
    [inlineNotification, workspace?.blockers],
  );
  // The agent's browser is the chat's right panel. Track whether it is open so
  // the header's Browser button reads as a toggle.
  const agentThreadId = agent?.threadId ?? null;
  const agentThreadRef = useMemo(
    () => (agentThreadId ? { environmentId, threadId: agentThreadId } : null),
    [agentThreadId, environmentId],
  );

  // A request can close without the composer ever knowing: resolved from
  // another window, dismissed, or answered by the agent itself. A tag
  // promising to close a request that is already gone has to come off.
  useEffect(() => {
    if (!agentThreadRef || !workspace) return;
    pruneWaitingOnYouAttachment(
      scopedThreadKey(agentThreadRef),
      new Set(
        workspace.blockers
          .filter((blocker) => blocker.resolvedAt === null)
          .map((blocker) => blocker.blockerId),
      ),
    );
  }, [agentThreadRef, workspace]);
  const previewState = useThreadPreviewState(agentThreadRef);
  const browserPanelOpen = useRightPanelStore((state) =>
    agentThreadId
      ? (state.byThreadKey[scopedThreadKey({ environmentId, threadId: agentThreadId })]?.isOpen ??
        false)
      : false,
  );
  const browserAvailable = browserPanelOpen || Object.keys(previewState.sessions).length > 0;
  const dashboardAvailable = hasAgentDashboard(workspace);
  const toggleBrowserPanel = () => {
    if (!agentThreadId) return;
    const threadRef = { environmentId, threadId: agentThreadId };
    const store = useRightPanelStore.getState();
    // From another view, always reveal the chat with the browser open; from
    // the chat, behave as a plain open/close toggle.
    if (view !== "chat") {
      setView("chat");
      store.open(threadRef, "preview");
      return;
    }
    if (browserPanelOpen) {
      store.setOpen(threadRef, false);
      return;
    }
    store.open(threadRef, "preview");
  };

  if (registryUnavailable) {
    return <CenteredNote text="Agents are unavailable. Reconnect to the host and try again." />;
  }

  if (registrySnapshot === null) {
    return <CenteredNote text="Loading agent…" />;
  }

  if (!agent) {
    return <CenteredNote text="This agent no longer exists." />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Same inset every other top-level header carries: with the sidebar
          collapsed, its open button floats over this row, and without the
          reserve it lands on top of the agent's name and purpose. */}
      <header
        className={cn(
          "@container/header-actions flex min-w-0 flex-col gap-2 px-3 py-2 sm:px-4 md:flex-row md:items-center md:justify-between md:gap-3 md:border-b",
          // On a phone the header is the project card from the mockup: a
          // rounded turn-box card under the top bar rather than a full-width
          // band. The floating sidebar control is hidden there too, so the
          // collapsed-sidebar reserve is only wanted from `md` up.
          "max-md:mx-3 max-md:mt-2 max-md:rounded-[14px] max-md:border max-md:border-[var(--line)] max-md:bg-card max-md:p-3",
          "md:" + COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          // This header spans the window even when the browser panel is open,
          // so unlike ChatHeader the reserve cannot ever drop to pr-0: on
          // Windows the native window controls overlay this row's right edge,
          // and with them the parked panel toggle. Container-level only from
          // `md` up, where the header is a single row. Stacked (phones), the
          // overlay occupies the first row's band alone — padding the whole
          // header pushed the actions row ~3.5rem off the right edge for
          // nothing, which read as a broken gap under the title.
          "md:pr-[var(--workspace-titlebar-content-right)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-3 pr-[var(--workspace-titlebar-content-right)] md:flex-1 md:pr-0">
          {view !== "chat" ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              aria-label="Back to agent chat"
              title="Back to chat"
              onClick={() => setView("chat")}
            >
              <ChevronLeftIcon />
            </Button>
          ) : null}
          {/* The agent's outlined glyph in a tile, then name and purpose. The
              name is the tools-menu trigger: the chevron beside it says so,
              and the menu is where Activity, Scheduled work, Rules and the
              Dashboard live. */}
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-surface-tile text-foreground/85"
          >
            <AgentGlyph name={agent.name} icon={agent.icon} className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Agent tools"
                    title="Agent tools"
                    className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h1 className="truncate text-[15px] font-semibold leading-5 text-foreground">
                  {agent.name}
                </h1>
                <ChevronDownIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={2.25}
                  aria-hidden
                />
              </MenuTrigger>
              <MenuPopup align="start" className="w-52">
                <MenuItem
                  className={view === "activity" ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setView("activity")}
                >
                  <GitForkIcon /> Activity
                </MenuItem>
                <MenuItem
                  className={view === "tasks" ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setView("tasks")}
                >
                  <ListTodoIcon /> Scheduled work
                </MenuItem>
                <MenuItem
                  className={view === "rules" ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setView("rules")}
                >
                  <ScrollTextIcon /> Rules
                </MenuItem>
                {dashboardAvailable ? (
                  <MenuItem
                    className={view === "dashboard" ? "bg-foreground/[0.08]" : undefined}
                    onClick={() => setView("dashboard")}
                  >
                    <LayoutDashboardIcon /> Dashboard
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
            <p className="truncate text-xs leading-4 text-muted-foreground">
              {view !== "chat"
                ? VIEW_LABELS[view]
                : agent.status === "stopped"
                  ? `Stopped · scheduled tasks paused · ${agent.purpose}`
                  : agent.purpose}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2 md:shrink-0">
          <AgentPowerToggle agent={agent} environmentId={environmentId} />
          {/* Agent threads reach the same remote machines as ordinary threads,
              so the control that connects to one belongs here too — a device
              driving an agent had no way to start a session from this header. */}
          <RemoteConnectionControl
            activeEnvironmentId={environmentId}
            className="h-7 rounded-full border-[var(--line)] bg-surface-row px-2.5 text-[12px] hover:bg-surface-hover"
          />
          {browserAvailable ? (
            <button
              type="button"
              aria-label="Browser"
              aria-pressed={view === "chat" && browserPanelOpen}
              title="Browser"
              onClick={toggleBrowserPanel}
              className={cn(
                "inline-flex h-7 cursor-pointer items-stretch overflow-hidden rounded-full border border-[var(--line)] text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                view === "chat" && browserPanelOpen
                  ? "border-[var(--gold-line)] bg-[var(--gold-tint)] text-foreground"
                  : "bg-surface-row text-foreground/85 hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <span className="flex items-center border-r border-[var(--line)] px-2">
                <GlobeIcon className="size-3.5" aria-hidden />
              </span>
              <span className="flex items-center px-2.5">Browser</span>
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {agent.threadId ? (
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {view === "chat" ? (
              <AgentChatSurface
                environmentId={environmentId}
                threadId={agent.threadId}
                inlineNotice={
                  inlineAttention.items.length === 0
                    ? null
                    : {
                        id: inlineAttention.items
                          .map((item) => `${item.id}:${item.occurredAt}`)
                          .join("|"),
                        content: (
                          <AgentAttentionStack
                            environmentId={environmentId}
                            attention={inlineAttention}
                            threadRef={{ environmentId, threadId: agent.threadId }}
                            onRevealChat={() => setView("chat")}
                          />
                        ),
                      }
                }
              />
            ) : view === "activity" ? (
              <AgentCollaborationPanel
                environmentId={environmentId}
                agent={agent}
                onOpenChat={() => setView("chat")}
              />
            ) : view === "tasks" ? (
              <AgentTasksPanel environmentId={environmentId} agent={agent} workspace={workspace} />
            ) : view === "rules" ? (
              <AgentRulesPanel environmentId={environmentId} agent={agent} />
            ) : (
              <AgentArtifactPanel workspace={workspace} />
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <CenteredNote text="This agent has no chat thread. Create a new agent for the full chat." />
          </div>
        )}
      </div>
    </div>
  );
}

function CenteredNote({ text }: { readonly text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {text}
    </div>
  );
}
