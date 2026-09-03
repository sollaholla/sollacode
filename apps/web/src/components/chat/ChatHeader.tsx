import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isElectron } from "~/env";
import { MessageSquareIcon } from "lucide-react";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";
import { RemoteConnectionControl } from "../remoteControl/RemoteConnectionControl";
import { TERMINAL_WORKING_DOT_CLASS, TerminalSessionIcon } from "./TerminalSessionIcon";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  /** Which surface fills the thread's main column; drives the header switch. */
  mainSurface?: "chat" | "terminal";
  onMainSurfaceChange?: (surface: "chat" | "terminal") => void;
  /** A subprocess is actively working in one of this thread's terminals. */
  terminalsWorking?: boolean;
  /** The thread's own agent turn is in flight (the chat surface is working). */
  chatWorking?: boolean;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

/**
 * Whether to offer "open in editor / reveal in the file manager".
 *
 * The action opens a directory on the machine running the app, so it only
 * means anything on a client that IS that machine. A phone, or a browser
 * connected over the network, is looking at the same project through a
 * transport that cannot open anything locally — the button either does
 * nothing visible or acts on a machine the user is not sitting at, and it
 * costs header room that a narrow layout does not have.
 *
 * The desktop bridge is the honest test: it exists only in the local desktop
 * app. Environment identity is not enough on its own — a remote browser is
 * still looking at the primary environment.
 */
export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** The client is the local desktop app, not a browser reaching it. */
  readonly isDesktopClient: boolean;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.isDesktopClient &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  mainSurface,
  onMainSurfaceChange,
  terminalsWorking = false,
  chatWorking = false,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScriptsQuery = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    isDesktopClient: isElectron,
  });
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${activeProjectName}`}
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          // The panel toggles are absolutely positioned over this row when the
          // right panel is closed, so the reserve has to track their real
          // width. The old flat `pr-16` was 8px short on desktop and 16px
          // short on phones, where the toggles grow to 2rem.
          rightPanelOpen ? "pr-0" : "pr-[var(--workspace-titlebar-content-right)]",
        )}
      >
        {mainSurface !== undefined && onMainSurfaceChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    mainSurface === "terminal" ? "Switch to chat mode" : "Switch to terminal mode"
                  }
                  onClick={() =>
                    onMainSurfaceChange(mainSurface === "terminal" ? "chat" : "terminal")
                  }
                  className={cn(
                    "inline-flex cursor-pointer items-center rounded-md p-1 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                    mainSurface === "terminal"
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              {mainSurface === "terminal" ? (
                // The dot advertises activity on the surface the button
                // switches TO: on the chat icon it means the agent is
                // mid-turn, not that a terminal is busy — that activity is
                // already visible right behind this header.
                <span className="relative inline-flex size-4 items-center justify-center">
                  <MessageSquareIcon className="size-4" aria-hidden />
                  {chatWorking ? (
                    <span
                      aria-label="Chat working"
                      className={TERMINAL_WORKING_DOT_CLASS}
                      role="status"
                    />
                  ) : null}
                </span>
              ) : (
                <TerminalSessionIcon
                  className="size-4"
                  working={terminalsWorking}
                  workingLabel="Terminals working"
                />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {mainSurface === "terminal" ? "Switch to chat mode" : "Switch to terminal mode"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            fileScripts={fileScriptsQuery.scripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRefreshFileScripts={fileScriptsQuery.refresh}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        <RemoteConnectionControl activeEnvironmentId={activeThreadEnvironmentId} />
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
