import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type VmAgent, VmAgentId } from "@t3tools/contracts";
import {
  BellIcon,
  GitForkIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MessageSquareIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState, type ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { AgentChatSurface } from "./AgentChatSurface";
import { AgentCollaborationPanel } from "./AgentCollaborationPanel";
import {
  EMPTY_AGENT_COLLABORATION_DRAFT,
  type AgentCollaborationDraft,
} from "./CreateDelegationDialog";
import { agentCollaborationDraftKey } from "./agentCollaborationDraft";
import {
  AgentArtifactPanel,
  AgentBlockerBanner,
  AgentNotificationsPanel,
  AgentTasksPanel,
  useAgentSystemNotifications,
} from "./AgentWorkspacePanels";

type AgentWorkspaceView = "chat" | "collaborate" | "tasks" | "artifact" | "notifications";

/**
 * The full surface for one agent: its single-thread chat (the real {@link
 * ChatView} — model picker, effort, usage, everything). The agent's browser is
 * the chat's collaborative preview panel, so the chat IS the workspace; the
 * other views (tasks, artifact, inbox) sit behind the header switch.
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
  const [collaborationDrafts, setCollaborationDrafts] = useState<
    Readonly<Record<string, AgentCollaborationDraft>>
  >({});

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
  const unreadCount =
    workspace?.notifications.filter(
      (notification) => notification.readAt === null && notification.archivedAt === null,
    ).length ?? 0;
  useAgentSystemNotifications(agent, workspace);
  // The agent's browser is the chat's right panel. Track whether it is open so
  // the header's Browser button reads as a toggle.
  const agentThreadId = agent?.threadId ?? null;
  const browserPanelOpen = useRightPanelStore((state) =>
    agentThreadId
      ? (state.byThreadKey[scopedThreadKey({ environmentId, threadId: agentThreadId })]?.isOpen ??
        false)
      : false,
  );
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

  const collaborationDraftStorageKey = agentCollaborationDraftKey(environmentId, agent.vmAgentId);
  const collaborationDraft =
    collaborationDrafts[collaborationDraftStorageKey] ?? EMPTY_AGENT_COLLABORATION_DRAFT;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Same inset every other top-level header carries: with the sidebar
          collapsed, its open button floats over this row, and without the
          reserve it lands on top of the agent's name and purpose. */}
      <header
        className={cn(
          "@container/header-actions flex min-w-0 flex-col gap-2 border-b px-3 py-2 sm:px-4 md:flex-row md:items-center md:justify-between md:gap-3",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          // This header spans the window even when the browser panel is open,
          // so unlike ChatHeader the reserve cannot ever drop to pr-0: on
          // Windows the native window controls overlay this row's right edge,
          // and with them the parked panel toggle.
          "pr-[var(--workspace-titlebar-content-right)]",
        )}
      >
        <div className="min-w-0 md:flex-1">
          <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
          <p className="truncate text-xs text-muted-foreground">{agent.purpose}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 md:shrink-0 md:flex-nowrap">
          <ViewButton
            active={view === "chat"}
            label="Chat"
            icon={<MessageSquareIcon className="size-3.5" />}
            onClick={() => setView("chat")}
          />
          <ViewButton
            active={view === "collaborate"}
            label="Collaborate"
            icon={<GitForkIcon className="size-3.5" />}
            onClick={() => setView("collaborate")}
          />
          <ViewButton
            active={view === "tasks"}
            label="Tasks"
            icon={<ListTodoIcon className="size-3.5" />}
            onClick={() => setView("tasks")}
          />
          <ViewButton
            active={view === "artifact"}
            label="Artifact"
            icon={<LayoutDashboardIcon className="size-3.5" />}
            onClick={() => setView("artifact")}
          />
          <ViewButton
            active={view === "notifications"}
            label="Inbox"
            icon={<BellIcon className="size-3.5" />}
            onClick={() => setView("notifications")}
            badge={unreadCount}
          />
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          <ViewButton
            active={view === "chat" && browserPanelOpen}
            label="Browser"
            icon={<GlobeIcon className="size-3.5" />}
            onClick={toggleBrowserPanel}
          />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {agent.threadId ? (
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            <AgentBlockerBanner
              environmentId={environmentId}
              workspace={workspace}
              threadRef={{ environmentId, threadId: agent.threadId }}
              onRevealChat={() => setView("chat")}
            />
            {view === "chat" ? (
              <AgentChatSurface environmentId={environmentId} threadId={agent.threadId} />
            ) : view === "collaborate" ? (
              <AgentCollaborationPanel
                environmentId={environmentId}
                agent={agent}
                draft={collaborationDraft}
                onDraftChange={(draft) =>
                  setCollaborationDrafts((current) => ({
                    ...current,
                    [collaborationDraftStorageKey]: draft,
                  }))
                }
                onOpenChat={() => setView("chat")}
              />
            ) : view === "tasks" ? (
              <AgentTasksPanel environmentId={environmentId} agent={agent} workspace={workspace} />
            ) : view === "artifact" ? (
              <AgentArtifactPanel workspace={workspace} />
            ) : (
              <AgentNotificationsPanel
                environmentId={environmentId}
                agent={agent}
                workspace={workspace}
              />
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

/**
 * Header action in the app's established workspace-header style: an outline
 * pill whose label collapses to icon-only when the header container is thin
 * (the same `@container/header-actions` pattern the chat header's Actions /
 * Remote control buttons use).
 */
function ViewButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly badge?: number;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={props.active ? "secondary" : "outline"}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
        {props.label}
      </span>
      {props.badge ? <Badge size="sm">{props.badge}</Badge> : null}
    </Button>
  );
}

function CenteredNote({ text }: { readonly text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {text}
    </div>
  );
}
