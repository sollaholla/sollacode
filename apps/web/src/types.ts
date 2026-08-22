import type {
  ChatImageAttachment as ContractChatImageAttachment,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectScript as ContractProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

/**
 * Recursive pane layout for one terminal group. Splitting the focused pane
 * nests a new split node in place of its leaf, so each split only divides the
 * pane it was invoked on — never the whole group.
 */
export type TerminalPaneLayout =
  | { kind: "terminal"; terminalId: string }
  | {
      kind: "split";
      direction: "horizontal" | "vertical";
      children: TerminalPaneLayout[];
      /**
       * Flex fractions aligned with children. Absent means equal shares;
       * dropped whenever the child count changes.
       */
      sizes?: number[];
    };

export interface ThreadTerminalGroup {
  id: string;
  /** User-assigned name; groups without one display a positional default. */
  name?: string;
  terminalIds: string[];
  /** Legacy flat-split direction; migrated into `layout` on normalization. */
  splitDirection?: "horizontal" | "vertical";
  /** Legacy flat-split fractions; migrated into `layout` on normalization. */
  paneSizes?: number[];
  /** Split tree over terminalIds. Absent for single-terminal groups. */
  layout?: TerminalPaneLayout;
}

/** Which surface fills a thread's main column: the chat timeline or the terminal workspace. */
export type ThreadMainSurface = "chat" | "terminal";

export interface ChatImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface ChatMessage extends Omit<OrchestrationMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

export type ProposedPlan = OrchestrationProposedPlan;
export type TurnDiffFileChange = OrchestrationCheckpointFile;
export type TurnDiffSummary = OrchestrationCheckpointSummary;

export type Project = EnvironmentProject;
export type Thread = EnvironmentThread;
export type ThreadShell = EnvironmentThreadShell;

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
}

export type SidebarThreadSummary = EnvironmentThreadShell;
export type ThreadSession = OrchestrationSession;
