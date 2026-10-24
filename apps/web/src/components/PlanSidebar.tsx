import { memo, useState, useCallback, useMemo } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { PanelProposedPlan, TaskListState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  describeProposedPlanStatus,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { projectEnvironment } from "~/state/projects";
import { threadEnvironment } from "../state/threads";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";

export const PLAN_REFRESH_MINIMUM_FEEDBACK_MS = 1_000;
export const PLAN_REFRESH_INITIATION_TIMEOUT_MS = 20_000;

export function remainingPlanRefreshFeedbackMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return PLAN_REFRESH_MINIMUM_FEEDBACK_MS;
  return Math.max(0, PLAN_REFRESH_MINIMUM_FEEDBACK_MS - Math.max(0, elapsedMs));
}

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

/**
 * Two different things, kept apart: the proposed plan (a proposal, with what
 * became of it) and the task list (the agent's progress checklist). Each says
 * when it is from, so tasks from other work never read as the plan's steps.
 */
interface PlanSidebarProps {
  taskList: TaskListState | null;
  proposedPlan: PanelProposedPlan | null;
  label?: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
}

const PlanSidebar = memo(function PlanSidebar({
  taskList,
  proposedPlan,
  label = "Plan",
  environmentId,
  threadRef,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
}: PlanSidebarProps) {
  // Per plan: a plan waiting for approval opens expanded, history collapsed.
  const [planExpansion, setPlanExpansion] = useState<{
    readonly planId: string;
    readonly expanded: boolean;
  } | null>(null);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [isRefreshingPlan, setIsRefreshingPlan] = useState(false);
  const refreshPlan = useAtomCommand(threadEnvironment.refreshPlan, "plan refresh");
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "plan" });

  const planMarkdown = proposedPlan?.plan.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const planStatus = proposedPlan ? describeProposedPlanStatus(proposedPlan.status) : null;
  const proposedPlanExpanded =
    proposedPlan !== null &&
    (planExpansion?.planId === proposedPlan.plan.id
      ? planExpansion.expanded
      : proposedPlan.status === "waiting");
  // Step text is the identity; a repeated step gets its occurrence number.
  const taskStepKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return (taskList?.steps ?? []).map((step) => {
      const occurrence = seen.get(step.step) ?? 0;
      seen.set(step.step, occurrence + 1);
      return occurrence === 0 ? step.step : `${step.step}#${occurrence}`;
    });
  }, [taskList]);
  const toggleProposedPlanExpanded = useCallback(() => {
    if (!proposedPlan) return;
    setPlanExpansion({ planId: proposedPlan.plan.id, expanded: !proposedPlanExpanded });
  }, [proposedPlan, proposedPlanExpanded]);

  /**
   * Hand the refresh to the server and return.
   *
   * Nothing is sent to the chat and no turn is started: the server re-reads the
   * conversation, rewrites the task list, and the panel picks the result up
   * through the same plan activity a provider would emit. The local busy flag
   * only debounces the button — the work itself is reported in the
   * background-tasks list.
   */
  const handleRefreshPlan = useCallback(() => {
    if (!threadRef || isRefreshingPlan) return;
    setIsRefreshingPlan(true);
    const startedAt = performance.now();
    void (async () => {
      let initiationTimeout: number | null = null;
      try {
        await Promise.race([
          refreshPlan({
            environmentId,
            input: { threadId: threadRef.threadId },
          }),
          new Promise<void>((resolve) => {
            initiationTimeout = window.setTimeout(resolve, PLAN_REFRESH_INITIATION_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (initiationTimeout !== null) window.clearTimeout(initiationTimeout);
        const remainingMs = remainingPlanRefreshFeedbackMs(performance.now() - startedAt);
        if (remainingMs > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
        }
        setIsRefreshingPlan(false);
      }
    })();
  }, [environmentId, isRefreshingPlan, refreshPlan, threadRef]);

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    if (!workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath: filename,
          contents: normalizePlanMarkdownForExport(planMarkdown),
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [environmentId, planMarkdown, workspaceRoot, writeProjectFile]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            {label}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {threadRef ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground/50 hover:text-foreground/70"
              onClick={handleRefreshPlan}
              disabled={isRefreshingPlan}
              aria-label="Refresh tasks from the conversation"
              title="Refresh tasks from the conversation"
            >
              <RefreshCwIcon className={cn("size-3.5", isRefreshingPlan && "animate-spin")} />
            </Button>
          ) : null}
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Proposed plan: the proposal, and what became of it */}
          {proposedPlan && planMarkdown && planStatus ? (
            <section className="space-y-2" aria-label="Proposed plan">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={toggleProposedPlanExpanded}
                  aria-expanded={proposedPlanExpanded}
                >
                  {proposedPlanExpanded ? (
                    <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40" />
                  ) : (
                    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
                  )}
                  <span className="min-w-0 truncate text-[13px] font-medium text-foreground/90 group-hover:text-foreground">
                    {planTitle ?? "Proposed plan"}
                  </span>
                </button>
                <Badge
                  variant={planStatus.variant}
                  size="sm"
                  className="shrink-0 rounded-md px-1.5 py-0 font-medium"
                  title={planStatus.detail}
                >
                  {planStatus.label}
                </Badge>
              </div>
              <p className="pl-[18px] text-[11px] text-muted-foreground/60 tabular-nums">
                Proposed {formatTimestamp(proposedPlan.plan.createdAt, timestampFormat)}
              </p>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    threadRef={threadRef}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Tasks: the agent's progress checklist, separate from any plan */}
          {taskList && taskList.steps.length > 0 ? (
            <section className="space-y-1" aria-label="Tasks">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                  Tasks
                </p>
                <span className="text-[11px] text-muted-foreground/60 tabular-nums">
                  {formatTimestamp(taskList.createdAt, timestampFormat)}
                </span>
              </div>
              {taskList.explanation ? (
                <p className="pb-1 text-[13px] leading-relaxed text-muted-foreground/80">
                  {taskList.explanation}
                </p>
              ) : null}
              {taskList.steps.map((step, index) => (
                <div
                  key={taskStepKeys[index]}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    step.status === "inProgress" && "bg-blue-500/5",
                    step.status === "completed" && "bg-emerald-500/5",
                  )}
                >
                  {stepStatusIcon(step.status)}
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </section>
          ) : null}

          {/* Empty state */}
          {!taskList && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No plan or tasks yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Proposed plans and the agent's task list appear here.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
