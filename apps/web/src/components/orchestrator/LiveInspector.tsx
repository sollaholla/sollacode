import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationLiveBeat,
  type OrchestrationLiveBeatKind,
} from "@t3tools/contracts";
import { useCanGoBack, useRouter, useSearch } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BellRingIcon,
  BrainIcon,
  FileTextIcon,
  InfoIcon,
  LayersIcon,
  MessageSquareQuoteIcon,
  PencilLineIcon,
  SearchIcon,
  SendIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { resolveShortcutCommand } from "../../keybindings";
import { cn, isMacPlatform } from "../../lib/utils";
import {
  describeCounts,
  describeElapsed,
  describeSection,
  presentBeat,
  projectDotClass,
  type CastMember,
  type CastStatus,
  type InspectorBeat,
} from "../../orchestrator/liveInspector";
import { useLiveInspector, type ThreadLabel } from "../../orchestrator/useLiveInspector";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { MACOS_TRAFFIC_LIGHTS_LEFT_INSET } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { LiveInspectorDock } from "./LiveInspectorDock";
import "./live-inspector.css";

const BEAT_ICONS: Record<OrchestrationLiveBeatKind, LucideIcon> = {
  command: TerminalIcon,
  read: FileTextIcon,
  edit: PencilLineIcon,
  search: SearchIcon,
  think: BrainIcon,
  tool: WrenchIcon,
  said: MessageSquareQuoteIcon,
  asked: SendIcon,
  task: LayersIcon,
  attention: BellRingIcon,
  error: TriangleAlertIcon,
  notice: InfoIcon,
};

const TONE_CLASS = {
  default: "text-foreground",
  attention: "text-amber-700 dark:text-amber-300",
  error: "text-destructive",
  muted: "text-muted-foreground",
} as const;

const STATUS_PILL: Record<CastStatus, string> = {
  "needs-you": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  working: "bg-gold-500/15 text-gold-700 dark:text-gold-300",
  failed: "bg-destructive/12 text-destructive",
  done: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
};

const STATUS_DOT: Record<CastStatus, string> = {
  "needs-you": "bg-amber-500",
  working: "bg-gold-500",
  failed: "bg-destructive",
  done: "bg-emerald-500",
};

const STATUS_BORDER: Record<CastStatus, string> = {
  "needs-you": "border-amber-500/50",
  working: "border-[var(--gold-line)]",
  failed: "border-destructive/40",
  done: "border-[var(--line)]",
};

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function formatClock(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? clockFormat.format(ms) : "";
}

/** Whether the macOS window buttons sit over the page's top left: a desktop window, not full screen. */
function useMacosWindowControlsOverlap(): boolean {
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [fullscreen, setFullscreen] = useState(() => {
    const read = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof read === "function" ? read() : false;
  });
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!isMacosDesktop || !bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }
    const unsubscribe = onWindowFullscreenStateChange(setFullscreen);
    setFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);
  return isMacosDesktop && !fullscreen;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** One beat as a line: an icon, a verb, and what it acted on. */
const BeatLine = memo(function BeatLine({
  beat,
  emphasis,
}: {
  beat: OrchestrationLiveBeat;
  emphasis: boolean;
}) {
  const presentation = presentBeat(beat);
  const Icon = BEAT_ICONS[beat.kind];
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 leading-snug",
        emphasis ? "text-sm" : "text-xs",
        TONE_CLASS[presentation.tone],
      )}
    >
      <Icon className={cn("mt-0.5 shrink-0", emphasis ? "size-4" : "size-3.5")} aria-hidden />
      <p className={cn("min-w-0 flex-1 break-words", emphasis ? "line-clamp-3" : "line-clamp-2")}>
        {presentation.lead !== null ? (
          <span className={cn("font-medium", beat.live && "text-gold-700 dark:text-gold-300")}>
            {presentation.lead}
          </span>
        ) : null}
        {presentation.body !== null ? (
          presentation.bodyStyle === "code" ? (
            <code className="ms-1.5 rounded bg-muted/70 px-1 py-px font-mono text-[0.92em] break-all">
              {presentation.body}
            </code>
          ) : presentation.bodyStyle === "quote" ? (
            <span className={cn(presentation.lead !== null && "ms-1.5", "text-foreground/90")}>
              “{presentation.body}”
            </span>
          ) : (
            <span
              className={cn(
                "ms-1.5",
                presentation.tone === "default" ? "text-muted-foreground" : undefined,
              )}
            >
              {presentation.body}
            </span>
          )
        ) : null}
      </p>
    </div>
  );
});

/**
 * One thread at a glance: what it is, what it says it is doing, and what it is
 * doing this second (or what it needs from the person).
 */
const CastCard = memo(function CastCard({
  member,
  nowMs,
  onOpen,
}: {
  member: CastMember;
  nowMs: number;
  onOpen: ((member: CastMember) => void) | null;
}) {
  const { snapshot, status, statusLabel, speech, action, latest } = member;
  const elapsed = describeElapsed(member.workingSince, nowMs);
  return (
    <article
      className={cn(
        "live-inspector-enter relative flex min-w-0 flex-col gap-2.5 rounded-2xl border bg-card p-4",
        STATUS_BORDER[status],
      )}
      data-testid="live-inspector-card"
    >
      {latest !== null ? (
        // Re-keyed by the newest beat: the card lights up once for each new move.
        <span
          key={latest.key}
          aria-hidden
          className="live-inspector-flash pointer-events-none absolute inset-0 rounded-2xl bg-gold-500/6 ring-1 ring-gold-500/50"
        />
      ) : null}
      <header className="flex min-w-0 items-center gap-2 text-xs">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
            STATUS_PILL[status],
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
          {elapsed === null ? statusLabel : `${statusLabel} · ${elapsed}`}
        </span>
        {onOpen !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="relative ms-auto shrink-0"
            aria-label={`Open ${snapshot.title}`}
            onClick={() => onOpen(member)}
          >
            <ArrowUpRightIcon />
          </Button>
        ) : null}
      </header>
      <h3 className="truncate text-[15px] font-medium text-foreground">{snapshot.title}</h3>
      {speech !== null && speech.beat.detail !== null ? (
        <p
          key={speech.key}
          className="live-inspector-enter line-clamp-3 text-sm leading-snug text-foreground/90"
        >
          “{speech.beat.detail}”
        </p>
      ) : null}
      {action !== null ? (
        <div key={action.key} className="live-inspector-enter">
          <BeatLine beat={action.beat} emphasis={false} />
        </div>
      ) : speech === null ? (
        <p className="text-sm text-muted-foreground">
          {status === "working" ? "Working on it…" : "Nothing new in the last few minutes."}
        </p>
      ) : null}
    </article>
  );
});

const TimelineRow = memo(function TimelineRow({
  entry,
  label,
}: {
  entry: InspectorBeat;
  label: ThreadLabel | undefined;
}) {
  return (
    <li className="live-inspector-enter flex min-w-0 gap-3">
      <time
        dateTime={entry.beat.at}
        className="w-16 shrink-0 pt-0.5 text-[11px] text-muted-foreground tabular-nums"
      >
        {formatClock(entry.beat.at)}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              label === undefined ? "bg-muted-foreground" : projectDotClass(label.projectId),
            )}
          />
          <span className="truncate">{label?.title ?? "A thread"}</span>
        </div>
        <BeatLine beat={entry.beat} emphasis={false} />
      </div>
    </li>
  );
});

/**
 * The Live Inspector: every thread's work as it happens, on one screen. Cards
 * for what is working or needs the person, a timeline of every move, and the
 * orchestrator a chat button away at the bottom.
 */
export function LiveInspector({
  embedded,
  onClose,
}: {
  /** Inside the phone app, whose own header closes it and opens threads. */
  embedded: boolean;
  onClose: () => void;
}) {
  const view = useLiveInspector();
  const router = useRouter();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [composerOpen, setComposerOpen] = useState(false);
  const clearWindowControls = useMacosWindowControlsOverlap();

  const openThread = useCallback(
    (member: CastMember) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(
            EnvironmentId.make(member.snapshot.environmentId),
            ThreadId.make(member.snapshot.threadId),
          ),
        ),
      });
    },
    [router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (composerOpen) {
          event.preventDefault();
          setComposerOpen(false);
        } else if (!embedded) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (view.orchestrator !== null) setComposerOpen(true);
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
        },
      });
      if (command === "orchestrator.live.toggle" && !embedded) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composerOpen, embedded, keybindings, onClose, view.orchestrator]);

  const counts = describeCounts(view.counts);

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background text-foreground">
      <header
        // A drag handle for the desktop window; its buttons stay clickable.
        className={cn(
          "flex shrink-0 items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 sm:px-6",
          isElectron && "drag-region",
        )}
        style={clearWindowControls ? { paddingLeft: MACOS_TRAFFIC_LIGHTS_LEFT_INSET } : undefined}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/12 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-destructive uppercase">
          <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
          Live
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Live Inspector</h1>
          <p className="truncate text-xs text-muted-foreground" data-testid="live-inspector-counts">
            {view.connecting ? "Connecting…" : counts}
          </p>
        </div>
        {!embedded ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ms-auto"
            aria-label="Close the Live Inspector"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 pt-2 pb-48 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-label="Threads on stage" className="min-w-0">
            {view.sections.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--line)] px-6 py-10 text-center">
                <p className="text-base font-medium">All quiet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Nothing is running right now. Threads appear here the moment they start working or
                  need you.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {view.sections.map((section) => (
                  <section
                    key={section.projectKey}
                    aria-label={section.projectName}
                    className="live-inspector-enter min-w-0"
                  >
                    <header className="mb-2 flex min-w-0 items-baseline gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "size-2.5 shrink-0 self-center rounded-full",
                          projectDotClass(section.projectId),
                        )}
                      />
                      <h2 className="truncate text-sm font-semibold text-foreground">
                        {section.projectName}
                      </h2>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {describeSection(section)}
                      </span>
                    </header>
                    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                      {section.members.map((member) => (
                        <CastCard
                          key={member.threadKey}
                          member={member}
                          nowMs={view.now}
                          onOpen={embedded ? null : openThread}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {view.offStage > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {view.offStage} more {view.offStage === 1 ? "thread" : "threads"} not shown.
              </p>
            ) : null}
          </section>

          <aside aria-label="Everything, as it happens" className="min-w-0">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Everything, as it happens
            </h2>
            {view.timeline.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {view.connecting ? "Waiting for the live feed…" : "No moves yet."}
              </p>
            ) : (
              <ol className="mt-3 flex flex-col gap-3">
                {view.timeline.map((entry) => (
                  <TimelineRow
                    key={entry.key}
                    entry={entry}
                    label={view.labels.get(entry.threadKey)}
                  />
                ))}
              </ol>
            )}
          </aside>
        </div>
      </main>

      <LiveInspectorDock
        orchestrator={view.orchestrator}
        subtitle={view.subtitle}
        orchestratorWorking={view.orchestratorWorking}
        composerOpen={composerOpen}
        onComposerOpenChange={setComposerOpen}
      />
    </div>
  );
}

/** The `/orchestrator/live` route: closing goes back where it was opened from. */
export function LiveInspectorRoute() {
  const search = useSearch({ strict: false }) as { readonly embedded?: unknown };
  const embedded = search.embedded === true || search.embedded === "1" || search.embedded === 1;
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const close = useCallback(() => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/", replace: true });
  }, [canGoBack, router]);
  return <LiveInspector embedded={embedded} onClose={close} />;
}
