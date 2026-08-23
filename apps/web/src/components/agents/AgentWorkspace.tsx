import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type VmAgent, VmAgentId } from "@t3tools/contracts";
import {
  BellIcon,
  GitForkIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MonitorIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { AgentChatSurface } from "./AgentChatSurface";
import { AgentCollaborationPanel } from "./AgentCollaborationPanel";
import {
  AgentArtifactPanel,
  AgentBlockerBanner,
  AgentNotificationsPanel,
  AgentTasksPanel,
  useAgentSystemNotifications,
} from "./AgentWorkspacePanels";
import { VmScreenView } from "./VmScreenView";

const MIN_FRACTION = 0.28;
const MAX_FRACTION = 0.72;
type AgentWorkspaceView = "chat" | "collaborate" | "tasks" | "artifact" | "notifications";
type CompactWorkspacePane = "workspace" | "computer";

/**
 * The full surface for one agent: its single-thread chat (the real {@link
 * ChatView} — model picker, effort, usage, everything) beside its live computer,
 * in a resizable split. The computer can be hidden to give the chat full width
 * or expanded to full screen from within its own pane.
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
  const isCompact = useMediaQuery("max-md");
  const [screenOpen, setScreenOpen] = useState(true);
  const [compactPane, setCompactPane] = useState<CompactWorkspacePane>("workspace");
  const [view, setView] = useState<AgentWorkspaceView>("chat");
  // Fraction of the width given to the chat pane; the computer takes the rest.
  const [chatFraction, setChatFraction] = useState(0.5);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

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
    workspace?.notifications.filter((notification) => !notification.readAt).length ?? 0;
  useAgentSystemNotifications(agent, workspace);
  const computerVisible = isCompact ? compactPane === "computer" : screenOpen;

  const onDividerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);
  const onDividerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    setChatFraction(Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction)));
  }, []);
  const onDividerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

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
          "flex min-w-0 flex-col gap-2 border-b px-3 py-2 sm:px-4 md:flex-row md:items-center md:justify-between md:gap-3",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
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
            icon={<MessageSquareIcon />}
            onClick={() => setView("chat")}
          />
          <ViewButton
            active={view === "collaborate"}
            label="Collaborate"
            icon={<GitForkIcon />}
            onClick={() => setView("collaborate")}
          />
          <ViewButton
            active={view === "tasks"}
            label="Tasks"
            icon={<ListTodoIcon />}
            onClick={() => setView("tasks")}
          />
          <ViewButton
            active={view === "artifact"}
            label="Artifact"
            icon={<LayoutDashboardIcon />}
            onClick={() => setView("artifact")}
          />
          <ViewButton
            active={view === "notifications"}
            label="Inbox"
            icon={<BellIcon />}
            onClick={() => setView("notifications")}
            badge={unreadCount}
          />
          <span className="mx-1 h-5 w-px bg-border max-md:hidden" />
          <Button
            type="button"
            size="sm"
            variant={computerVisible ? "default" : "outline"}
            aria-pressed={computerVisible}
            aria-label={computerVisible ? "Hide computer" : "Show computer"}
            title={computerVisible ? "Hide computer" : "Show computer"}
            disabled={agent.threadId === null}
            onClick={() => {
              if (isCompact) {
                setCompactPane((pane) => (pane === "computer" ? "workspace" : "computer"));
                return;
              }
              setScreenOpen((open) => !open);
            }}
          >
            {computerVisible ? (
              <PanelRightCloseIcon className="size-3.5" />
            ) : (
              <MonitorIcon className="size-3.5" />
            )}
            <span className="hidden lg:inline">
              {computerVisible ? "Hide computer" : "Show computer"}
            </span>
          </Button>
        </div>
      </header>

      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {agent.threadId ? (
          <div
            className={cn(
              "h-full min-h-0 min-w-0 flex-col",
              compactPane === "computer" ? "hidden md:flex" : "flex",
            )}
            style={{
              flexBasis: isCompact ? "100%" : screenOpen ? `${chatFraction * 100}%` : "100%",
              flexGrow: isCompact ? 1 : 0,
              flexShrink: isCompact ? 1 : 0,
            }}
          >
            <AgentBlockerBanner environmentId={environmentId} workspace={workspace} />
            {view === "chat" ? (
              <AgentChatSurface environmentId={environmentId} threadId={agent.threadId} />
            ) : view === "collaborate" ? (
              <AgentCollaborationPanel
                environmentId={environmentId}
                agent={agent}
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

        {!isCompact && screenOpen && agent.threadId ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              className={cn(
                "group relative w-1.5 shrink-0 cursor-col-resize touch-none bg-border",
                "hover:bg-primary/40",
              )}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
            >
              <span className="absolute inset-y-0 -left-1 -right-1" />
            </div>
            <div className="h-full min-h-0 min-w-0 flex-1">
              <VmScreenView agent={agent} environmentId={environmentId} />
            </div>
          </>
        ) : null}
        {isCompact && compactPane === "computer" && agent.threadId ? (
          <div className="h-full min-h-0 min-w-0 flex-1">
            <VmScreenView agent={agent} environmentId={environmentId} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
      size="sm"
      variant={props.active ? "secondary" : "ghost"}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="hidden xl:inline">{props.label}</span>
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
