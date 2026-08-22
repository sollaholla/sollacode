import { interpolate, spring, useCurrentFrame, useVideoConfig } from "../motion";
import { AppWindow, Composer, MainHeader, Sidebar, type ThreadRowData } from "../ui/Shell";
import { CheckIcon } from "../ui/icons";

const THREADS: readonly ThreadRowData[] = [
  {
    title: "Migrate the settings schema",
    project: "solla-code",
    age: "1m",
    active: true,
    working: true,
  },
  { title: "Publish the release notes", project: "solla-code", age: "9m" },
];

const LIMIT_FRAME = 78;
const FAILOVER_FRAME = 100;

function ProviderChip({
  name,
  state,
  usage,
}: {
  readonly name: string;
  readonly state: "active" | "limited" | "standby";
  readonly usage: number;
}) {
  const tone =
    state === "limited" ? "#e5b567" : state === "active" ? "#34d399" : "var(--muted-foreground)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        minWidth: 210,
        padding: "11px 13px",
        borderRadius: 11,
        border: `1px solid ${
          state === "active"
            ? "color-mix(in srgb, #34d399 45%, transparent)"
            : state === "limited"
              ? "color-mix(in srgb, #e5b567 45%, transparent)"
              : "var(--border)"
        }`,
        background: "var(--card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{name}</span>
        <span style={{ fontSize: 11, color: tone }}>
          {state === "limited" ? "usage limit" : state === "active" ? "active" : "standby"}
        </span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: "var(--muted)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.round(usage * 100)}%`,
            height: "100%",
            borderRadius: 999,
            background: tone,
          }}
        />
      </div>
    </div>
  );
}

export function ProviderFailover() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Usage climbs to the ceiling, the limit event lands, and the queued turn
  // resumes on the standby provider. No work is lost, which is the whole point.
  const primaryUsage = interpolate(frame, [10, LIMIT_FRAME], [0.42, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const limited = frame >= LIMIT_FRAME;
  const failedOver = frame >= FAILOVER_FRAME;
  const standbyUsage = failedOver
    ? interpolate(frame, [FAILOVER_FRAME, FAILOVER_FRAME + 60], [0.08, 0.34], {
        extrapolateRight: "clamp",
      })
    : 0.08;

  const noticeIn = spring({
    frame: frame - LIMIT_FRAME,
    fps,
    config: { damping: 200 },
    durationInFrames: 18,
  });
  const resumeIn = spring({
    frame: frame - FAILOVER_FRAME,
    fps,
    config: { damping: 200 },
    durationInFrames: 18,
  });

  return (
    <AppWindow>
      <Sidebar
        agentsExpanded
        threadsExpanded
        threads={THREADS}
        agents={[{ name: "Scout", status: "running" }]}
        revealCount={THREADS.length}
      />
      <main style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <MainHeader project="solla-code" title="Migrate the settings schema" />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: "10px 22px 14px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", gap: 10 }}>
            <ProviderChip
              name="Claude Code"
              state={limited ? "limited" : "active"}
              usage={primaryUsage}
            />
            <ProviderChip
              name="Codex"
              state={failedOver ? "active" : "standby"}
              usage={standbyUsage}
            />
          </div>

          {limited ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 13px",
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, #e5b567 40%, transparent)",
                background: "color-mix(in srgb, #e5b567 10%, transparent)",
                opacity: noticeIn,
                transform: `translateY(${interpolate(noticeIn, [0, 1], [6, 0])}px)`,
              }}
            >
              <span style={{ fontSize: 12.5, color: "#e5b567", fontWeight: 500 }}>
                Usage limit reached
              </span>
              <span style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
                Typed limit event · resets 4:50pm · turn queued, not dropped
              </span>
            </div>
          ) : null}

          {failedOver ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                opacity: resumeIn,
                transform: `translateY(${interpolate(resumeIn, [0, 1], [6, 0])}px)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 15,
                    height: 15,
                    borderRadius: 999,
                    background: "#34d399",
                  }}
                >
                  <CheckIcon size={9} color="#04140d" strokeWidth={3} />
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
                  Failed over to Codex and resumed the queued turn
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Picking up where the previous provider stopped: the settings schema migration is
                written and the decoder defaults are covered by tests.
              </p>
            </div>
          ) : null}
        </div>
        <Composer placeholder="Ask anything, @tag files/folders, $use skills, or / for commands" />
      </main>
    </AppWindow>
  );
}
