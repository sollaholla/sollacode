import { interpolate, spring, useCurrentFrame, useVideoConfig } from "../motion";

import { AppWindow, Composer, MainHeader, Sidebar, type ThreadRowData } from "../ui/Shell";
import { BotIcon, CheckIcon } from "../ui/icons";

const THREADS: readonly ThreadRowData[] = [
  {
    title: "Audit provider failover",
    project: "solla-code",
    age: "5m",
    active: true,
    working: true,
  },
  { title: "Collapsible sidebar sections", project: "solla-code", age: "18m" },
];

interface Step {
  readonly at: number;
  readonly label: string;
  readonly detail: string;
}

const STEPS: readonly Step[] = [
  { at: 30, label: "Delegated to Scout", detail: "Bounded worker · capabilities: read, search" },
  { at: 70, label: "Scout asked a question", detail: "“Include the MCP bridge adapter?”" },
  { at: 108, label: "Answered", detail: "Yes — treat it as a first-class provider" },
  { at: 146, label: "Result returned", detail: "3 adapters missing typed limit events" },
];

function Timeline() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {STEPS.map((step, index) => {
        const enter = spring({
          frame: frame - step.at,
          fps,
          config: { damping: 200 },
          durationInFrames: 18,
        });
        const complete = frame > step.at + 26;
        return (
          <div
            key={step.label}
            style={{
              display: "flex",
              gap: 10,
              opacity: enter,
              transform: `translateY(${interpolate(enter, [0, 1], [6, 0])}px)`,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: complete ? "#34d399" : "var(--muted)",
                  border: complete ? "none" : "1px solid var(--border)",
                }}
              >
                {complete ? <CheckIcon size={11} color="#04140d" strokeWidth={3} /> : null}
              </div>
              {index < STEPS.length - 1 ? (
                <div style={{ flex: 1, width: 1, background: "var(--border)", marginTop: 3 }} />
              ) : null}
            </div>
            <div style={{ paddingBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{step.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted-foreground)", marginTop: 1 }}>
                {step.detail}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CustomAgents() {
  const frame = useCurrentFrame();
  const delegations = frame > 30 && frame < 150 ? 1 : 0;

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
        <MainHeader project="solla-code" title="Audit provider failover" />
        <div style={{ flex: 1, minHeight: 0, padding: "6px 22px 0" }}>
          <div
            style={{
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "var(--card)",
              padding: 15,
              maxWidth: 460,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 13 }}>
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background: "var(--muted)",
                }}
              >
                <BotIcon size={15} color="var(--foreground)" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Scout</div>
                <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                  Soloman&rsquo;s MacBook Pro
                </div>
              </div>
              {delegations > 0 ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    minWidth: 20,
                    height: 18,
                    padding: "0 6px",
                    borderRadius: 999,
                    background: "color-mix(in srgb, var(--primary) 18%, transparent)",
                    color: "var(--foreground)",
                    fontSize: 10.5,
                    fontWeight: 500,
                  }}
                >
                  {delegations} active
                </span>
              ) : null}
            </div>
            <Timeline />
          </div>
        </div>
        <Composer placeholder="Ask Scout to widen the audit, or bring the result back into this thread" />
      </main>
    </AppWindow>
  );
}
