import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  AGENT_BUILDER_THREAD_ID,
  type EnvironmentId,
  type VmAgent,
  type VmAgentCollaborationAgentSummary,
} from "@t3tools/contracts";
import {
  BellIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  HandIcon,
  MessageSquareDotIcon,
  PlusIcon,
  PowerIcon,
  ShieldAlertIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { toastManager } from "../ui/toast";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { hasUnseenCompletion, resolveSidebarV2Status } from "../Sidebar.logic";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { cn } from "../../lib/utils";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOnScreenKeyboard } from "../../hooks/useOnScreenKeyboard";
import { useSidebarRowSwipe } from "../useSidebarRowSwipe";
import type { SidebarSwipeDirection } from "../sidebarRowSwipe";
import type { SidebarThreadSummary } from "../../types";
import { AgentGlyph } from "./AgentGlyph";
import {
  agentPowerActionLabel,
  agentPowerSwitchable,
  agentPowerTitle,
  agentStatusDotClass,
  agentStatusLabel,
  useAgentPowerToggle,
} from "./AgentPowerToggle";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { DeleteAgentDialog } from "./DeleteAgentDialog";
import {
  agentRegistryNoticeCopy,
  environmentIdFromUnknown,
  resolveAgentRegistryNotice,
  sortAgentEnvironments,
} from "./agentRegistryState";
import { shouldSendAgentDesktopNotification } from "./agentNotifications";

const AGENT_SECTION_BODY_ID = "agent-stack-sections";

export type AgentBuilderButtonStatus = "working" | "success" | "input" | "error";

export const AGENT_BUILDER_BUTTON_STATUS_PRESENTATION = {
  working: {
    label: "Working",
    dotClass: "bg-gold-500 dark:bg-gold-300/80",
    pulse: true,
  },
  success: {
    label: "Success",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    pulse: false,
  },
  input: {
    label: "Input needed",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    pulse: false,
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500 dark:bg-red-300/90",
    pulse: false,
  },
} as const satisfies Record<
  AgentBuilderButtonStatus,
  { readonly label: string; readonly dotClass: string; readonly pulse: boolean }
>;

type AgentBuilderStatusThread = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & { readonly lastVisitedAt?: string };

/**
 * Project the singleton builder thread onto the four states its icon can show.
 * Pending interaction wins over all other state, matching ordinary thread
 * rows; a disconnected host suppresses an unverifiable working state.
 */
export function resolveAgentBuilderButtonStatus(
  thread: AgentBuilderStatusThread | null,
  environmentUnreachable = false,
): AgentBuilderButtonStatus | null {
  if (thread === null) return null;

  const status = resolveSidebarV2Status({ ...thread, environmentUnreachable });
  if (status === "approval" || status === "input") return "input";
  if (status === "working") return "working";
  if (status === "failed" || thread.latestTurn?.state === "error") return "error";
  if (thread.latestTurn?.state === "completed" && hasUnseenCompletion(thread)) return "success";
  return null;
}

/**
 * Opens the singleton Agent Builder chat — one persistent thread per host,
 * created lazily on first click, that designs agents from a single prompt.
 * A dialog used to collect the prompt and model here; the chat's own composer
 * already does both, so the button is now just navigation. The thread is
 * deliberately listed nowhere — this button is its only doorway, so it reads
 * as a tool you summon rather than a chat you keep.
 */
function useOpenAgentBuilder() {
  const router = useRouter();
  const builderOpen = useAtomCommand(vmAgentEnvironment.builderOpen, { reportFailure: false });
  return useCallback(
    (environmentId: EnvironmentId) => {
      void builderOpen({ environmentId, input: {} }).then((result) => {
        if (result._tag === "Success") {
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: result.value.threadId },
          });
          return;
        }
        toastManager.add({
          type: "error",
          title: "The Agent Builder chat could not be opened.",
        });
      });
    },
    [builderOpen, router],
  );
}

export function activeDelegationsForAgent(
  agents: ReadonlyArray<Pick<VmAgentCollaborationAgentSummary, "vmAgentId" | "activeDelegations">>,
  vmAgentId: string,
): number {
  return agents.find((agent) => agent.vmAgentId === vmAgentId)?.activeDelegations ?? 0;
}

export function attentionForAgent(
  agents: ReadonlyArray<{
    readonly vmAgentId: string;
    readonly unreadNotificationCount: number;
    readonly openBlockerCount: number;
  }>,
  vmAgentId: string,
) {
  return (
    agents.find((agent) => agent.vmAgentId === vmAgentId) ?? {
      vmAgentId,
      unreadNotificationCount: 0,
      openBlockerCount: 0,
    }
  );
}

/**
 * The Agent Stack's sidebar section, rendered directly below the orchestrator
 * entry. Lists the user's named agents; clicking one opens its dedicated
 * chat and workspace. Hidden when `agentStackEnabled` is off.
 */
export function AgentStackSidebarEntry() {
  const enabled = useClientSettings((settings) => settings.agentStackEnabled);
  const desktopNotificationsEnabled = useClientSettings(
    (settings) => settings.agentDesktopNotificationsEnabled,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const expanded = useUiStateStore((state) => state.agentsSectionExpanded);
  const setExpanded = useUiStateStore((state) => state.setAgentsSectionExpanded);
  const [createForEnvironmentId, setCreateForEnvironmentId] = useState<EnvironmentId | null>(null);
  const openAgentBuilder = useOpenAgentBuilder();
  const orderedEnvironments = useMemo(() => {
    const entries = environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
    }));
    if (
      primaryEnvironmentId !== null &&
      !entries.some((entry) => entry.environmentId === primaryEnvironmentId)
    ) {
      entries.push({ environmentId: primaryEnvironmentId, label: "Local host" });
    }
    return sortAgentEnvironments(entries, primaryEnvironmentId);
  }, [environments, primaryEnvironmentId]);

  // Which host's create dialog is open, hoisted so the section header can
  // raise it for the single-host case without owning a dialog per host.
  const singleEnvironmentId =
    orderedEnvironments.length === 1 ? (orderedEnvironments[0]?.environmentId ?? null) : null;

  if (!enabled || orderedEnvironments.length === 0) return null;

  return (
    <>
      {desktopNotificationsEnabled
        ? orderedEnvironments.map((environment) => (
            <AgentDesktopNotificationObserver
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          ))
        : null}
      <div className="mt-1 flex min-w-0 flex-col gap-1" data-agent-environment-list>
        {/* The add control belongs on this row, beside the section it adds to —
          not on a row of its own below it. It cannot go inside the toggle
          (nesting a button in a button), so the two share a flex row. */}
        <div className="flex min-w-0 items-center gap-1 pr-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            // Only while the body is mounted: collapsed unmounts it, and pointing
            // aria-controls at an id that is not in the document is worse than omitting it.
            aria-controls={expanded ? AGENT_SECTION_BODY_ID : undefined}
            data-testid="agents-section-toggle"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground"
          >
            <span className="min-w-0 truncate">Agents</span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 opacity-60 transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          </button>
          {singleEnvironmentId ? (
            <>
              <BuildAgentButton
                environmentId={singleEnvironmentId}
                onClick={() => openAgentBuilder(singleEnvironmentId)}
              />
              <NewAgentButton onClick={() => setCreateForEnvironmentId(singleEnvironmentId)} />
            </>
          ) : null}
        </div>
        {/* Collapsed drops the sections entirely rather than hiding them: each one
          holds a live agent-registry subscription per host, and a closed section
          has no reason to keep streaming. */}
        {expanded ? (
          <div id={AGENT_SECTION_BODY_ID} className="flex min-w-0 flex-col gap-1">
            {orderedEnvironments.map((environment) => (
              <AgentEnvironmentSection
                key={environment.environmentId}
                environmentId={environment.environmentId}
                environmentLabel={environment.label}
                showEnvironmentLabel={orderedEnvironments.length > 1}
                createOpen={createForEnvironmentId === environment.environmentId}
                onCreateOpenChange={(open) =>
                  setCreateForEnvironmentId(open ? environment.environmentId : null)
                }
                onOpenBuilder={() => openAgentBuilder(environment.environmentId)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Native alerts remain active even when the visual Agents section is folded.
 * This subscribes only to lightweight agent and attention summaries, never to
 * every agent's full workspace or notification bodies.
 */
function AgentDesktopNotificationObserver(props: { readonly environmentId: EnvironmentId }) {
  const router = useRouter();
  const activeAgentId = useParams({
    strict: false,
    select: (params) => (params as { agentId?: string }).agentId ?? null,
  });
  const activeEnvironmentId = useParams({
    strict: false,
    select: (params) =>
      environmentIdFromUnknown((params as { environmentId?: unknown }).environmentId),
  });
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const attentionAtom = useMemo(
    () => vmAgentEnvironment.attention({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const agentsResult = useAtomValue(agentsAtom);
  const attentionResult = useAtomValue(attentionAtom);
  const agentsItem = Option.getOrNull(AsyncResult.value(agentsResult));
  const attentionItem = Option.getOrNull(AsyncResult.value(attentionResult));
  const agents = agentsItem?.type === "snapshot" ? agentsItem.agents : [];
  const attention = attentionItem?.type === "snapshot" ? attentionItem.agents : null;
  const previousUnreadCounts = useRef<ReadonlyMap<string, number> | null>(null);

  useEffect(() => {
    if (attention === null) return;
    const nextCounts = new Map(
      attention.map((entry) => [String(entry.vmAgentId), entry.unreadNotificationCount]),
    );
    const previous = previousUnreadCounts.current;
    previousUnreadCounts.current = nextCounts;
    if (previous === null) return;

    for (const entry of attention) {
      const agent = agents.find((candidate) => candidate.vmAgentId === entry.vmAgentId);
      if (!agent) continue;
      const isAgentFocused =
        entry.vmAgentId === activeAgentId &&
        props.environmentId === activeEnvironmentId &&
        document.visibilityState === "visible" &&
        document.hasFocus();
      if (
        !shouldSendAgentDesktopNotification({
          enabled: true,
          permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
          previousUnreadCount: previous.get(String(entry.vmAgentId)) ?? 0,
          unreadCount: entry.unreadNotificationCount,
          isAgentFocused,
        })
      ) {
        continue;
      }
      const notification = new Notification(`${agent.name} has a new alert`, {
        body:
          entry.unreadNotificationCount === 1
            ? "Open the agent chat to read it."
            : `${entry.unreadNotificationCount} unread alerts. Open the agent chat to read the newest one.`,
        tag: `agent-alert:${props.environmentId}:${agent.vmAgentId}`,
      });
      notification.addEventListener("click", () => {
        window.focus();
        void router.navigate({
          to: "/agents/$environmentId/$agentId",
          params: {
            environmentId: props.environmentId,
            agentId: agent.vmAgentId,
          },
        });
        notification.close();
      });
    }
  }, [activeAgentId, activeEnvironmentId, agents, attention, props.environmentId, router]);

  return null;
}

/**
 * One agent in the sidebar, with the two ways to delete it.
 *
 * A pointer device gets an X beside the name, revealed on hover like every
 * other row action. Touch gets a slide to the right, because there is no hover
 * to reveal anything and a permanent X next to a navigation target is a
 * mis-tap waiting to happen. Both only *open* the confirmation — neither
 * deletes on its own.
 */
function AgentSidebarRow(props: {
  readonly agent: VmAgent;
  readonly activeWork: number;
  readonly openBlockers: number;
  readonly unreadNotifications: number;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly isActive: boolean;
  readonly onOpen: () => void;
  readonly onRequestDelete: () => void;
  readonly onTogglePower: () => void;
  readonly powerBusy: boolean;
}) {
  const { agent, onRequestDelete, onTogglePower } = props;
  const usesTouch = useOnScreenKeyboard();
  // The agent's chat thread is the truth about whether it is mid-turn; the
  // status dot only says its VM is up. Icon-only on purpose — these rows have
  // no room for the thread list's "Working 2m" pill.
  const threadShell = useThreadShell(
    agent.threadId ? { environmentId: props.environmentId, threadId: agent.threadId } : null,
  );
  const rowEnvironment = useEnvironment(props.environmentId);
  const environmentUnreachable =
    rowEnvironment != null && rowEnvironment.connection.phase !== "connected";
  const status =
    threadShell === null
      ? null
      : resolveSidebarV2Status({ ...threadShell, environmentUnreachable });
  const working = status === "working";
  // An agent parked on an approval or a question is the one state on this row
  // the user has to act on, so it outranks "working" here exactly as it does
  // in resolveSidebarV2Status. Without it these rows read as busy, and a
  // background agent could sit waiting for a yes indefinitely, unnoticed.
  const needsApproval = status === "approval";
  const needsInput = status === "input";
  // "Done" on the same terms as a thread row: a turn that finished after the
  // last time this conversation was opened. Same store, same helper, so an
  // agent and its thread can never disagree about having finished.
  const lastVisitedAt = useUiStateStore((state) =>
    agent.threadId === null
      ? undefined
      : state.threadLastVisitedAtById[
          scopedThreadKey({ environmentId: props.environmentId, threadId: agent.threadId })
        ],
  );
  const done =
    !working &&
    !needsApproval &&
    !needsInput &&
    threadShell !== null &&
    hasUnseenCompletion({ ...threadShell, ...(lastVisitedAt ? { lastVisitedAt } : {}) });
  const resolveAction = useCallback(
    (direction: SidebarSwipeDirection) => (direction === "right" ? "delete" : null),
    [],
  );
  const swipe = useSidebarRowSwipe<"delete">({
    enabled: usesTouch,
    resolveAction,
    onCommit: onRequestDelete,
  });
  const { consumeSuppressedClick } = swipe;
  const handleOpen = useCallback(() => {
    // A row that slid must not also open the agent it slid.
    if (consumeSuppressedClick()) return;
    props.onOpen();
  }, [consumeSuppressedClick, props]);

  return (
    <div className="relative overflow-hidden">
      {swipe.state.offset !== 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1.5 rounded-md bg-destructive/15 px-3 text-xs font-medium text-destructive"
          style={{
            width: `${Math.abs(swipe.state.offset)}px`,
            opacity: swipe.state.armed ? 1 : 0.45 + swipe.state.progress * 0.4,
          }}
        >
          <Trash2Icon className="size-3.5 shrink-0" />
          <span className="truncate">Delete</span>
        </div>
      ) : null}
      <SidebarMenuButton
        type="button"
        isActive={props.isActive}
        onClick={handleOpen}
        aria-label={`Open ${agent.name} on ${props.environmentLabel}${needsApproval ? ", waiting for your approval" : needsInput ? ", waiting for your input" : ""}${props.unreadNotifications > 0 ? `, ${props.unreadNotifications} unread ${props.unreadNotifications === 1 ? "alert" : "alerts"}` : ""}`}
        data-testid="agent-sidebar-entry"
        className={cn(
          "group/agent-row",
          usesTouch && "touch-pan-y",
          !swipe.state.dragging && swipe.state.offset === 0 && "transition-transform duration-200",
        )}
        style={
          swipe.state.offset === 0
            ? undefined
            : { transform: `translateX(${swipe.state.offset}px)` }
        }
        {...swipe.handlers}
      >
        <AgentGlyph name={agent.name} icon={agent.icon} />
        <span className="flex-1 truncate text-left">{agent.name}</span>
        {/* Deliberately identical to the thread rows' working indicator, minus
            their "Working 4m" label — same CircleDashedIcon, same sky tint,
            same duty-cycled fade from `animate-sidebar-working-text`. It span
            spun on `text-primary` before, which read as a different kind of
            state than the one the threads below it were showing. The span
            wrapper is load-bearing: SidebarMenuButton repaints direct <svg>
            children muted grey, which would eat the sky tint. */}
        {needsApproval ? (
          // Amber approval / indigo input, the hues sidebar v1, the thread rows
          // and the mobile Live Activity all use for these two states.
          <span
            title="Waiting for your approval"
            className="flex shrink-0 items-center text-amber-700 dark:text-amber-300"
          >
            <ShieldAlertIcon className="size-4 shrink-0" aria-label="Waiting for your approval" />
          </span>
        ) : needsInput ? (
          <span
            title="Waiting for your input"
            className="flex shrink-0 items-center text-blue-600 dark:text-blue-300"
          >
            <MessageSquareDotIcon className="size-4 shrink-0" aria-label="Waiting for your input" />
          </span>
        ) : working ? (
          <span
            title="Working"
            className="flex shrink-0 items-center animate-sidebar-working-text text-gold-600 motion-reduce:animate-none dark:text-gold-400"
          >
            <CircleDashedIcon className="size-4 shrink-0" aria-label="Working" />
          </span>
        ) : done ? (
          // Same slot, same emerald as the thread rows' "Done", label dropped
          // for width exactly like the working icon above it.
          <span
            title="Done"
            className="flex shrink-0 items-center text-emerald-700 dark:text-emerald-300"
          >
            <CircleCheckIcon className="size-4 shrink-0" aria-label="Done" />
          </span>
        ) : null}
        {/* The wrapper keeps SidebarMenuButton from repainting the hand icon
            as its default muted direct-child SVG. */}
        {props.openBlockers > 0 ? (
          <span
            className="inline-flex min-w-5 shrink-0 items-center justify-center gap-1 rounded-full bg-warning px-1.5 text-[10px] font-semibold tabular-nums text-amber-950"
            aria-label={`${props.openBlockers} waiting on you`}
            title={`${props.openBlockers} waiting on you`}
          >
            <HandIcon className="size-2.5" aria-hidden />
            {props.openBlockers}
          </span>
        ) : null}
        {props.unreadNotifications > 0 ? (
          <span
            className="inline-flex min-w-5 shrink-0 items-center justify-center gap-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold tabular-nums text-primary-foreground"
            aria-label={`${props.unreadNotifications} unread ${props.unreadNotifications === 1 ? "agent alert" : "agent alerts"}`}
            title="Open the newest unread alert"
          >
            <BellIcon className="size-2.5" aria-hidden />
            {props.unreadNotifications}
          </span>
        ) : null}
        {props.activeWork > 0 ? (
          <span
            className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/12 px-1.5 text-[10px] font-medium tabular-nums text-primary"
            aria-label={`${props.activeWork} active ${props.activeWork === 1 ? "delegation" : "delegations"}`}
            title={`${props.activeWork} active ${props.activeWork === 1 ? "delegation" : "delegations"}`}
          >
            {props.activeWork}
          </span>
        ) : null}
        {/* In a fixed slot, not bare: a 6px dot right-aligned at the padding
            edge sits visibly right of the section's + buttons, which centre
            their glyphs inside a hit-target. The slot gives the dot the same
            centred geometry, so the two line up in the gutter. */}
        <span
          aria-hidden="true"
          title={agentStatusLabel(agent.status)}
          className={cn(
            "flex shrink-0 items-center justify-center",
            !usesTouch && "-mr-0.5 size-5",
          )}
        >
          <span className={cn("size-1.5 rounded-full", agentStatusDotClass(agent.status))} />
        </span>
        {/* The on/off switch shares the X's reveal rules below: hidden until
            the row is hovered or focused, reachable but undrawn on touch. */}
        {agentPowerSwitchable(agent.status) ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`${agentPowerActionLabel(agent.status)} ${agent.name}`}
            aria-disabled={props.powerBusy || undefined}
            title={agentPowerTitle(agent)}
            className={cn(
              "-mr-0.5 size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground",
              agent.status !== "running" && "text-gold-700 dark:text-gold-300",
              props.powerBusy && "animate-pulse",
              usesTouch
                ? "sr-only"
                : "hidden group-hover/agent-row:inline-flex group-focus-within/agent-row:inline-flex",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTogglePower();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onTogglePower();
            }}
          >
            <PowerIcon className="size-3.5" />
          </span>
        ) : null}
        {/* Collapsed out of layout while hidden, not made transparent: a
            reserved-but-invisible box left the status dot sitting beside a
            hole at the row's edge. When the X appears the dot simply yields
            left; when it is away the dot holds the edge. Undrawn on touch
            rather than unmounted, because sliding is a gesture assistive tech
            cannot perform, so the control stays reachable where it is not
            painted. On pointer devices focus-within does the revealing — a
            display-collapsed element cannot be tabbed to, so focusing the row
            is what materialises the X, and the next tab stop is the X itself. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={`Delete ${agent.name}`}
          title={`Delete ${agent.name}`}
          className={cn(
            "-mr-0.5 size-5 shrink-0 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive",
            usesTouch
              ? "sr-only"
              : "hidden group-hover/agent-row:inline-flex group-focus-within/agent-row:inline-flex",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete();
          }}
        >
          <XIcon className="size-3.5" />
        </span>
      </SidebarMenuButton>
    </div>
  );
}

function NewAgentButton(props: { readonly onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="New agent"
            data-testid="agents-add"
            // The 44px target is for touch; on a fine pointer it is just a
            // tall band beside a one-line header.
            className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground pointer-fine:min-h-7 pointer-fine:min-w-7"
            onClick={props.onClick}
          />
        }
      >
        <PlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="right">New agent</TooltipPopup>
    </Tooltip>
  );
}

function BuildAgentButton(props: {
  readonly environmentId: EnvironmentId;
  readonly onClick: () => void;
}) {
  const threadShell = useThreadShell({
    environmentId: props.environmentId,
    threadId: AGENT_BUILDER_THREAD_ID,
  });
  const environment = useEnvironment(props.environmentId);
  const lastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[
        scopedThreadKey({
          environmentId: props.environmentId,
          threadId: AGENT_BUILDER_THREAD_ID,
        })
      ],
  );
  const status = resolveAgentBuilderButtonStatus(
    threadShell === null
      ? null
      : { ...threadShell, ...(lastVisitedAt === undefined ? {} : { lastVisitedAt }) },
    environment !== null && environment.connection.phase !== "connected",
  );
  const presentation = status === null ? null : AGENT_BUILDER_BUTTON_STATUS_PRESENTATION[status];
  const accessibleLabel =
    presentation === null
      ? "Build an agent with AI"
      : `Build an agent with AI — ${presentation.label}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={accessibleLabel}
            data-testid="agents-build"
            className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground pointer-fine:min-h-7 pointer-fine:min-w-7"
            onClick={props.onClick}
          />
        }
      >
        <span className="relative inline-flex">
          <SparklesIcon className="size-3.5" />
          {presentation ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -right-1 -top-1 size-1.5 rounded-full ring-1 ring-sidebar",
                presentation.dotClass,
                presentation.pulse && "animate-status-pulse motion-reduce:animate-none",
              )}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right">{accessibleLabel}</TooltipPopup>
    </Tooltip>
  );
}

function AgentEnvironmentSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironmentLabel: boolean;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
  readonly onOpenBuilder: () => void;
}) {
  const router = useRouter();
  const environment = useEnvironment(props.environmentId);
  const power = useAgentPowerToggle(props.environmentId);
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const collaborationAtom = useMemo(
    () => vmAgentEnvironment.collaboration({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  const attentionAtom = useMemo(
    () => vmAgentEnvironment.attention({ environmentId: props.environmentId, input: {} }),
    [props.environmentId],
  );
  // Held as the agent rather than an id so the dialog can name it even if the
  // row disappears from the list mid-confirmation.
  const [pendingDelete, setPendingDelete] = useState<VmAgent | null>(null);
  const activeAgentId = useParams({
    strict: false,
    select: (params) => (params as { agentId?: string }).agentId ?? null,
  });
  const activeEnvironmentId = useParams({
    strict: false,
    select: (params) =>
      environmentIdFromUnknown((params as { environmentId?: unknown }).environmentId),
  });
  const result = useAtomValue(agentsAtom);
  const collaborationResult = useAtomValue(collaborationAtom);
  const attentionResult = useAtomValue(attentionAtom);
  const failureCause = AsyncResult.isFailure(result) ? result.cause : null;
  const latest = Option.getOrNull(AsyncResult.value(result));
  const snapshot = latest && latest.type === "snapshot" ? latest : null;
  const agents: ReadonlyArray<VmAgent> = snapshot?.agents ?? [];
  // Close the confirmation as soon as its agent stops existing. The registry
  // stream is the truth about deletion; waiting only on the delete RPC's reply
  // left the dialog spinning on "Deleting…" after the agent was provably gone
  // (observed live: the row vanished, the server span succeeded in ~9s, and
  // the dialog never learned). This also covers another client deleting the
  // same agent while the dialog is open.
  const pendingDeleteId = pendingDelete?.vmAgentId ?? null;
  useEffect(() => {
    if (pendingDeleteId === null || snapshot === null) return;
    if (snapshot.agents.some((entry) => entry.vmAgentId === pendingDeleteId)) return;
    setPendingDelete(null);
  }, [pendingDeleteId, snapshot]);
  const collaborationItem = Option.getOrNull(AsyncResult.value(collaborationResult));
  const collaborationSnapshot = collaborationItem?.type === "snapshot" ? collaborationItem : null;
  const attentionItem = Option.getOrNull(AsyncResult.value(attentionResult));
  const attentionSnapshot = attentionItem?.type === "snapshot" ? attentionItem : null;
  const notice = resolveAgentRegistryNotice({
    hasSnapshot: snapshot !== null,
    agentCount: agents.length,
    failureCause,
    connectionPhase: environment?.connection.phase ?? null,
  });

  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-agent-environment={props.environmentId}>
      {/* Only when there is a host name to attach it to. With a single host
          the label is hidden, which left this row holding nothing but the
          button — a band of empty sidebar between the section header and the
          first agent. The header carries the button in that case. */}
      {props.showEnvironmentLabel ? (
        <div className="flex min-w-0 items-center justify-between pl-2 pr-1">
          <span
            className="min-w-0 truncate text-[11px] text-sidebar-muted-foreground/65"
            title={props.environmentLabel}
          >
            {props.environmentLabel}
          </span>
          <div className="flex shrink-0 items-center">
            <BuildAgentButton environmentId={props.environmentId} onClick={props.onOpenBuilder} />
            <NewAgentButton onClick={() => props.onCreateOpenChange(true)} />
          </div>
        </div>
      ) : null}

      {agents.length === 0 && notice !== null && notice !== "stale" ? (
        <p className="min-w-0 break-words px-2 py-1 text-xs leading-relaxed text-sidebar-muted-foreground/60">
          {agentRegistryNoticeCopy(notice)}
        </p>
      ) : (
        agents.map((agent) => {
          const activeWork = activeDelegationsForAgent(
            collaborationSnapshot?.agents ?? [],
            agent.vmAgentId,
          );
          const attention = attentionForAgent(attentionSnapshot?.agents ?? [], agent.vmAgentId);
          return (
            <AgentSidebarRow
              key={agent.vmAgentId}
              agent={agent}
              activeWork={activeWork}
              openBlockers={attention.openBlockerCount}
              unreadNotifications={attention.unreadNotificationCount}
              environmentId={props.environmentId}
              environmentLabel={props.environmentLabel}
              isActive={
                agent.vmAgentId === activeAgentId && props.environmentId === activeEnvironmentId
              }
              onOpen={() =>
                void router.navigate({
                  to: "/agents/$environmentId/$agentId",
                  params: {
                    environmentId: props.environmentId,
                    agentId: agent.vmAgentId,
                  },
                })
              }
              onRequestDelete={() => setPendingDelete(agent)}
              onTogglePower={() => void power.toggle(agent)}
              powerBusy={power.busyAgentId === agent.vmAgentId}
            />
          );
        })
      )}

      {agents.length > 0 && notice === "stale" ? (
        <p className="min-w-0 break-words px-2 py-1 text-[11px] leading-relaxed text-sidebar-muted-foreground/55">
          Reconnecting… showing last-known agents.
        </p>
      ) : null}

      <CreateAgentDialog
        open={props.createOpen}
        onOpenChange={props.onCreateOpenChange}
        environmentId={props.environmentId}
      />

      {pendingDelete ? (
        <DeleteAgentDialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
          environmentId={props.environmentId}
          agentId={pendingDelete.vmAgentId}
          agentName={pendingDelete.name}
        />
      ) : null}
    </div>
  );
}
