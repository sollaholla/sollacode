import {
  CheckIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SearchIcon,
  SendHorizontalIcon,
  SettingsIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode } from "react";

import { AgentGlyph } from "../agents/AgentGlyph";
import { ClaudeAI, Gemini, OpenAI } from "../Icons";
import { cn } from "../../lib/utils";
import { type WelcomeTourStepId } from "./welcomeTour.logic";

const at = (delayMs: number, extra?: Record<string, string>) =>
  ({ "--wt-d": `${delayMs}ms`, ...extra }) as CSSProperties;

function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative h-64 w-full overflow-hidden rounded-2xl border border-[var(--line)] bg-surface-row select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Types out a short phrase word by word; its words must not repeat. */
function Words({
  text,
  startMs,
  stepMs = 110,
}: {
  text: string;
  startMs: number;
  stepMs?: number;
}) {
  return (
    <>
      {text.split(" ").map((word, index) => (
        <span key={word} className="wt-word me-[0.3em]" style={at(startMs + index * stepMs)}>
          {word}
        </span>
      ))}
    </>
  );
}

function ProjectScene() {
  const files = [
    { name: "index.html", Icon: FileIcon },
    { name: "styles.css", Icon: FileIcon },
    { name: "photo.png", Icon: ImageIcon },
  ];
  return (
    <Stage className="flex items-center justify-center gap-5 px-5">
      <div className="wt-pop relative flex shrink-0 flex-col items-center gap-2.5" style={at(80)}>
        <span className="flex size-24 items-center justify-center rounded-3xl border border-[var(--gold-line)] bg-gold-500/10">
          <FolderIcon className="size-12 text-gold-500" />
        </span>
        <span className="text-sm font-medium text-foreground">my-website</span>
        <span
          className="wt-from absolute -top-2.5 -right-2.5 flex h-7 items-center rounded-full bg-gold-500 px-2.5 text-xs font-semibold text-black"
          style={at(1250, { "--wt-x": "110px", "--wt-y": "-30px" })}
        >
          AI
        </span>
      </div>
      <ul className="flex min-w-0 flex-col gap-2">
        {files.map(({ name, Icon }, index) => (
          <li
            key={name}
            className="wt-in flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--card)] px-3 text-[13px] text-foreground"
            style={at(420 + index * 170)}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            {name}
          </li>
        ))}
      </ul>
    </Stage>
  );
}

function MockComposer({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="absolute inset-x-3 bottom-3 flex h-12 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--card)] ps-3 pe-2">
      <span className="min-w-0 flex-1 text-sm leading-5 text-foreground">{children}</span>
      {trailing}
    </div>
  );
}

function AskScene() {
  return (
    <Stage>
      {/* The page being changed: the result is the point, not the chat. */}
      <div className="absolute inset-x-3 top-3 rounded-xl border border-[var(--line)] bg-[var(--card)]">
        <div className="flex gap-1 px-3 pt-2.5">
          <span className="size-1.5 rounded-full bg-foreground/20" />
          <span className="size-1.5 rounded-full bg-foreground/20" />
          <span className="size-1.5 rounded-full bg-foreground/20" />
        </div>
        <div className="flex h-24 items-center justify-center">
          <span className="relative">
            <span className="block rounded-lg bg-foreground/15 px-5 py-2 text-sm font-medium text-foreground">
              Buy now
            </span>
            <span
              className="wt-pop absolute inset-0 flex items-center justify-center rounded-lg bg-blue-500 text-sm font-medium text-white"
              style={at(2000)}
            >
              Buy now
            </span>
          </span>
        </div>
      </div>
      <div
        className="wt-in absolute inset-x-3 bottom-[4.25rem] flex items-center gap-1.5 px-1 text-[13px] text-foreground"
        style={at(2300)}
      >
        <CheckIcon className="size-4 shrink-0 text-success-foreground" />
        Done. The button is blue now.
      </div>
      <MockComposer
        trailing={
          <span
            className="wt-press flex size-8 shrink-0 items-center justify-center rounded-lg bg-gold-500 text-black"
            style={at(1450)}
          >
            <SendHorizontalIcon className="size-4" />
          </span>
        }
      >
        <span className="wt-flash block" style={at(250, { "--wt-t": "1500ms" })}>
          <Words text="Make the button blue" startMs={350} />
        </span>
      </MockComposer>
    </Stage>
  );
}

function ModelScene() {
  const models = [
    { name: "Claude", Icon: ClaudeAI },
    { name: "Codex", Icon: OpenAI },
    { name: "Gemini", Icon: Gemini },
  ];
  return (
    <Stage>
      <div
        className="wt-in absolute start-3 end-3 bottom-[4.25rem] rounded-xl border border-[var(--line)] bg-[var(--card)] p-1.5 sm:end-auto sm:w-56"
        style={at(500)}
      >
        <span
          className="wt-from absolute inset-x-1.5 top-[6.125rem] h-11 rounded-lg bg-gold-500/15"
          style={at(1300, { "--wt-x": "0", "--wt-y": "-5.5rem" })}
        />
        {models.map(({ name, Icon }) => (
          <div
            key={name}
            className="relative flex h-11 items-center gap-2.5 px-2.5 text-sm text-foreground"
          >
            <Icon className="size-4.5" />
            {name}
          </div>
        ))}
      </div>
      <MockComposer>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span
            className="wt-press relative flex size-8 items-center justify-center overflow-hidden rounded-lg border border-[var(--gold-line)]"
            style={at(180)}
          >
            <span className="wt-flash absolute" style={at(0, { "--wt-t": "2000ms" })}>
              <ClaudeAI className="size-4.5" />
            </span>
            <span className="wt-in" style={at(1950)}>
              <Gemini className="size-4.5" />
            </span>
          </span>
          Message
        </span>
      </MockComposer>
    </Stage>
  );
}

function ThreadRow({
  title,
  status,
  titleClassName,
  className,
  style,
}: {
  title: string;
  status: ReactNode;
  titleClassName?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "absolute inset-x-3 flex h-12 items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-[var(--card)] ps-3 pe-2 text-sm text-foreground",
        className,
      )}
      style={style}
    >
      <span
        className={cn("truncate", titleClassName)}
        style={{ "--wt-d": "1800ms" } as CSSProperties}
      >
        {title}
      </span>
      {status}
    </div>
  );
}

function ThreadsScene() {
  const working = (
    <span className="flex shrink-0 items-center gap-1 pe-1 text-xs text-gold-500">
      <LoaderCircleIcon className="size-3.5" />
      Working
    </span>
  );
  // Rows are 3.5rem apart. The finished one drops to the Settled group below the
  // other two, which move up into its place.
  return (
    <Stage>
      <ThreadRow
        title="Fix the login page"
        status={working}
        className="wt-from top-3"
        style={at(1700, { "--wt-x": "0", "--wt-y": "3.5rem" })}
      />
      <ThreadRow
        title="Write the help docs"
        status={working}
        className="wt-from top-[4.5rem]"
        style={at(1700, { "--wt-x": "0", "--wt-y": "3.5rem" })}
      />
      <span
        className="wt-in absolute start-4 top-[8.25rem] text-xs font-medium text-muted-foreground"
        style={at(1900)}
      >
        Settled
      </span>
      <ThreadRow
        title="Add a contact page"
        titleClassName="wt-dim"
        status={
          <span className="relative flex h-7 shrink-0 items-center text-xs text-success-foreground">
            {/* Makes room for Settle, then slides back when it has gone. */}
            <span
              className="wt-from flex items-center gap-1 pe-1"
              style={at(1500, { "--wt-x": "-4.25rem", "--wt-y": "0" })}
            >
              <CheckIcon className="size-3.5" />
              Done
            </span>
            <span
              className="wt-flash absolute inset-y-0 end-0 flex items-center rounded-md border border-[var(--gold-line)] bg-[var(--card)] px-2.5 text-foreground"
              style={at(400, { "--wt-t": "1200ms" })}
            >
              <span className="wt-press inline-block" style={at(1150)}>
                Settle
              </span>
            </span>
          </span>
        }
        className="wt-from top-[10rem] z-10"
        style={at(1700, { "--wt-x": "0", "--wt-y": "-9.25rem" })}
      />
    </Stage>
  );
}

function SearchScene({ shortcut }: { readonly shortcut: string | null }) {
  const results = [
    { title: "Add a dark theme", detail: "Chat", Icon: MessageSquareIcon },
    { title: "Theme", detail: "Setting", Icon: SettingsIcon },
    { title: "Change the theme colors", detail: "Chat", Icon: MessageSquareIcon },
  ];
  return (
    <Stage className="p-3">
      <div
        className="wt-pop flex h-12 items-center gap-2.5 rounded-xl border border-[var(--gold-line)] bg-[var(--card)] px-3 text-sm text-foreground"
        style={at(100)}
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <Words text="theme" startMs={600} />
        </span>
        {shortcut ? (
          <kbd className="wt-press rounded-md border border-[var(--line)] px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
            {shortcut}
          </kbd>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {results.map(({ title, detail, Icon }, index) => (
          <li
            key={title}
            className={cn(
              "wt-in flex h-12 items-center gap-2.5 rounded-xl border bg-[var(--card)] px-3 text-sm text-foreground",
              index === 0 ? "border-[var(--gold-line)]" : "border-[var(--line)]",
            )}
            style={at(1000 + index * 220)}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </li>
        ))}
      </ul>
    </Stage>
  );
}

function AgentsScene() {
  return (
    <Stage className="flex flex-col gap-2 p-3">
      <div className="wt-in flex h-14 items-center gap-3 px-1" style={at(80)}>
        <AgentGlyph agentId="welcome-tour" online avatarColor={3} className="size-12" />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">Morning helper</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ClockIcon className="size-3" />
            Every day at 9:00
          </span>
        </span>
      </div>
      {["Check for new orders", "Write the daily summary"].map((job, index) => (
        <div
          key={job}
          className="wt-in flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--card)] px-3 text-sm text-foreground"
          style={at(500 + index * 450)}
        >
          <span className="wt-pop" style={at(850 + index * 450)}>
            <CheckIcon className="size-4 text-success-foreground" />
          </span>
          {job}
        </div>
      ))}
      <div
        className="wt-in absolute inset-x-3 bottom-3 flex h-12 items-center rounded-xl border border-[var(--gold-line)] bg-gold-500/15 px-3 text-sm text-foreground"
        style={at(1900)}
      >
        Your summary is ready.
      </div>
    </Stage>
  );
}

/** A small silent picture of the step's idea. It plays once when the step opens. */
export function WelcomeIllustration({
  step,
  shortcut,
}: {
  readonly step: WelcomeTourStepId;
  /** The search shortcut, on devices that have a keyboard. */
  readonly shortcut: string | null;
}) {
  switch (step) {
    case "project":
      return <ProjectScene />;
    case "ask":
      return <AskScene />;
    case "model":
      return <ModelScene />;
    case "threads":
      return <ThreadsScene />;
    case "search":
      return <SearchScene shortcut={shortcut} />;
    case "agents":
      return <AgentsScene />;
  }
}
