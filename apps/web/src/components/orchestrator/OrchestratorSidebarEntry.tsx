import { useCallback } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AudioLinesIcon, MicIcon, MicOffIcon } from "lucide-react";

import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAtomValue } from "@effect/atom-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useOrchestratorThread } from "../../orchestrator/useOrchestratorThread";
import { useOrchestratorSessionContext } from "../../orchestrator/OrchestratorSessionProvider";
import type { VoiceSessionState } from "../../orchestrator/realtimeSession";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { cn } from "../../lib/utils";

const VOICE_STATE_LABEL: Record<VoiceSessionState, string> = {
  idle: "Talk to the orchestrator",
  connecting: "Connecting…",
  listening: "Listening — click to stop",
  speaking: "Speaking — click to stop",
  error: "Voice unavailable — click to retry",
};

/**
 * The orchestrator's always-visible entry point.
 *
 * It renders in the sidebar's non-scrolling `fixedHeader` slot rather than as a
 * row in the thread list, so it can never be scrolled away, sorted below active
 * work, or swept into bulk selection. `isSidebarListedThread` correspondingly
 * excludes it from the list itself, so it appears exactly once.
 *
 * Navigation deliberately reuses the ordinary `/$environmentId/$threadId` route
 * instead of a dedicated `/orchestrator` one: that keeps deep links, the active
 * highlight and ChatView working with no routing changes at all.
 */
export function OrchestratorSidebarEntry({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}) {
  const router = useRouter();
  const orchestrator = useOrchestratorThread();
  const voice = useOrchestratorSessionContext();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Surface the binding on the control itself; a shortcut nobody can find is a
  // shortcut nobody uses.
  const voiceShortcutLabel = shortcutLabelForCommand(keybindings, "orchestrator.voice.toggle");
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });

  const handleClick = useCallback(() => {
    if (!orchestrator) return;
    onNavigate?.();
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(orchestrator.ref),
    });
  }, [onNavigate, orchestrator, router]);

  const handleSetUpVoice = useCallback(() => {
    onNavigate?.();
    void router.navigate({ to: "/settings/orchestrator" });
  }, [onNavigate, router]);

  // Render nothing until an environment has bootstrapped its shell — a dead row
  // that navigates nowhere is worse than no row.
  if (!orchestrator) return null;

  const isActive =
    routeTarget?.kind === "server" &&
    scopedThreadKey(routeTarget.threadRef) === scopedThreadKey(orchestrator.ref);

  const isWorking = orchestrator.shell.latestTurn?.state === "running";
  const voiceLive = voice !== null && voice.state !== "idle" && voice.state !== "error";

  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <SidebarMenuButton
          type="button"
          isActive={isActive}
          onClick={handleClick}
          aria-label="Orchestrator"
          data-testid="orchestrator-sidebar-entry"
          className="focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
        >
          <AudioLinesIcon className={cn((isWorking || voiceLive) && "text-primary")} />
          <div className="flex-1 truncate text-left">Orchestrator</div>
          {isWorking ? (
            <span
              aria-hidden="true"
              className="mr-px size-1.5 shrink-0 rounded-full bg-primary"
              data-testid="orchestrator-sidebar-working"
            />
          ) : null}
        </SidebarMenuButton>
      </div>
      {voice !== null ? (
        <div className="shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="icon"
                  type="button"
                  // Deliberately still rendered when unconfigured, routing to
                  // settings instead. Hiding it left no trace that voice
                  // existed at all, which reads as "the feature is missing"
                  // rather than "the feature needs a key".
                  onClick={voice.canStart ? voice.toggle : handleSetUpVoice}
                  aria-pressed={voiceLive}
                  aria-label={
                    voice.canStart
                      ? voiceLive
                        ? "Stop talking to the orchestrator"
                        : "Talk to the orchestrator"
                      : "Set up the orchestrator voice"
                  }
                  data-testid="orchestrator-voice-toggle"
                  className={cn(
                    "focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                    voiceLive && "text-primary",
                    !voice.canStart && "text-sidebar-muted-foreground",
                  )}
                />
              }
            >
              {voiceLive ? <MicIcon /> : <MicOffIcon />}
            </TooltipTrigger>
            <TooltipPopup side="right">
              {!voice.canStart
                ? "Add the selected voice provider's API key in Settings → Orchestrator to talk"
                : voiceShortcutLabel
                  ? `${VOICE_STATE_LABEL[voice.state]} (${voiceShortcutLabel})`
                  : VOICE_STATE_LABEL[voice.state]}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
