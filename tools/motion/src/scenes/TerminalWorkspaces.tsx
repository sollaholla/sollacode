import { interpolate, spring, useCurrentFrame, useVideoConfig } from "../motion";

import { AppWindow, MainHeader, Sidebar, type ThreadRowData } from "../ui/Shell";

const THREADS: readonly ThreadRowData[] = [
  { title: "Stabilize release verification", project: "solla-code", age: "2m", active: true },
  { title: "Collapsible sidebar sections", project: "solla-code", age: "18m" },
  { title: "Voice reconnection stability", project: "solla-code", age: "3h" },
];

interface PaneLine {
  readonly text: string;
  readonly tone?: "dim" | "ok" | "warn" | "prompt";
}

const PANES: readonly {
  readonly name: string;
  readonly lines: readonly PaneLine[];
}[] = [
  {
    name: "dev",
    lines: [
      { text: "$ vp run dev", tone: "prompt" },
      { text: "[dev-runner] serverPort=13773 webPort=5733", tone: "dim" },
      { text: "  ➜  Local:   http://127.0.0.1:5733/" },
      { text: "  ✓ ready in 812 ms", tone: "ok" },
    ],
  },
  {
    name: "test",
    lines: [
      { text: "$ vp test run --project unit", tone: "prompt" },
      { text: " Test Files  297 passed (297)", tone: "ok" },
      { text: "      Tests  3051 passed (3051)", tone: "ok" },
      { text: "   Duration  20.70s", tone: "dim" },
    ],
  },
  {
    name: "agent",
    lines: [
      { text: "$ claude", tone: "prompt" },
      { text: "› Reading previewMiniPlayerLayout.ts", tone: "dim" },
      { text: "› Edit  ThreadPreviewMiniPlayer.tsx", tone: "dim" },
      { text: "✓ 16 tests added", tone: "ok" },
    ],
  },
  {
    name: "git",
    lines: [
      { text: "$ git status --short", tone: "prompt" },
      { text: " M apps/web/src/browser/browserSurfaceStore.ts", tone: "warn" },
      { text: " M apps/web/src/components/preview/…", tone: "warn" },
      { text: "$ ", tone: "prompt" },
    ],
  },
];

const TONE: Record<NonNullable<PaneLine["tone"]>, string> = {
  dim: "var(--muted-foreground)",
  ok: "#34d399",
  warn: "#e5b567",
  prompt: "var(--brand-gold)",
};

function Pane({
  name,
  lines,
  startFrame,
  active,
}: {
  readonly name: string;
  readonly lines: readonly PaneLine[];
  readonly startFrame: number;
  readonly active: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
    durationInFrames: 20,
  });
  const visibleLines = Math.max(
    0,
    Math.floor(
      interpolate(frame - startFrame, [8, 8 + lines.length * 9], [0, lines.length], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    ),
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        borderRadius: 10,
        border: `1px solid ${active ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "var(--border)"}`,
        background: "var(--card)",
        overflow: "hidden",
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [8, 0])}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--muted-foreground)",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: active ? "#34d399" : "var(--muted-foreground)",
          }}
        />
        {name}
      </div>
      <div
        style={{
          flex: 1,
          padding: "8px 10px",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: 1.7,
          whiteSpace: "pre",
          overflow: "hidden",
        }}
      >
        {lines.slice(0, visibleLines).map((line) => (
          <div key={line.text} style={{ color: line.tone ? TONE[line.tone] : "var(--foreground)" }}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TerminalWorkspaces() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 25 });

  return (
    <AppWindow style={{ opacity: enter }}>
      <Sidebar
        agentsExpanded
        threadsExpanded
        threads={THREADS}
        agents={[{ name: "Scout", status: "running" }]}
        revealCount={THREADS.length}
      />
      <main style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <MainHeader project="solla-code" title="Stabilize release verification" />
        <div style={{ padding: "0 14px 6px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>Layout</span>
          <span
            style={{
              height: 21,
              display: "inline-flex",
              alignItems: "center",
              padding: "0 8px",
              borderRadius: 6,
              background: "var(--muted)",
              fontSize: 11.5,
            }}
          >
            release-check
          </span>
          <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
            4 panes · retained
          </span>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            margin: "0 14px 14px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gridTemplateRows: "1fr 1fr",
            gap: 8,
          }}
        >
          {PANES.map((pane, index) => (
            <Pane
              key={pane.name}
              name={pane.name}
              lines={pane.lines}
              startFrame={12 + index * 14}
              active={index === 2}
            />
          ))}
        </div>
      </main>
    </AppWindow>
  );
}
