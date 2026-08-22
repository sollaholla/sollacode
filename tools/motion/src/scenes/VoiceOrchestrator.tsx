import { interpolate, spring, useCurrentFrame, useVideoConfig } from "../motion";
import { AppWindow, MainHeader, Sidebar, type ThreadRowData } from "../ui/Shell";
import { AudioLinesIcon, CheckIcon } from "../ui/icons";

const BASE_THREADS: readonly ThreadRowData[] = [
  { title: "Audit provider failover", project: "solla-code", age: "12m" },
  { title: "Mobile approval recovery", project: "solla-mobile", age: "1d" },
];

/** The thread the orchestrator creates partway through, in reply to the ask. */
const ROUTED_THREAD: ThreadRowData = {
  title: "Fix preload verification",
  project: "solla-code",
  age: "now",
  active: true,
  working: true,
};

const TRANSCRIPT = "Check the release run, then open a thread for whatever is failing.";

const ACTIONS: readonly { readonly at: number; readonly label: string }[] = [
  { at: 96, label: "Read 4 CI gates across the release run" },
  { at: 122, label: "Created thread “Fix preload verification”" },
  { at: 148, label: "Routed it to Claude Code with the failing log" },
];

/** A voice level meter. Deterministic per frame, so renders are reproducible. */
function Waveform({ active }: { readonly active: boolean }) {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height: 26 }}>
      {Array.from({ length: 28 }, (_, index) => {
        // A couple of out-of-phase sines read as speech without randomness.
        const wave =
          Math.sin(frame * 0.28 + index * 0.55) * 0.5 + Math.sin(frame * 0.17 + index * 1.31) * 0.5;
        const height = active ? 4 + Math.abs(wave) * 20 : 3;
        return (
          <span
            key={index}
            style={{
              width: 3,
              height,
              borderRadius: 999,
              background: active ? "var(--brand-gold)" : "var(--muted-foreground)",
              opacity: active ? 0.5 + Math.abs(wave) * 0.5 : 0.35,
            }}
          />
        );
      })}
    </div>
  );
}

export function VoiceOrchestrator() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 25 });

  const listening = frame > 14 && frame < 92;
  const spoken = Math.max(0, Math.floor((frame - 20) * 1.15));
  const transcript = TRANSCRIPT.slice(0, spoken);

  const threads = frame > 122 ? [ROUTED_THREAD, ...BASE_THREADS] : BASE_THREADS;

  return (
    <AppWindow style={{ opacity: enter }}>
      <Sidebar
        agentsExpanded
        threadsExpanded
        threads={threads}
        agents={[{ name: "Scout", status: "running" }]}
        revealCount={threads.length}
        orchestratorActive={listening || frame >= 92}
      />
      <main style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <MainHeader project="Orchestrator" title="Workspace voice" />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: "10px 22px 18px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            gap: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              padding: "22px 30px",
              borderRadius: 16,
              border: "1px solid var(--border)",
              background: "var(--card)",
              minWidth: 520,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <AudioLinesIcon
                size={16}
                color={listening ? "var(--brand-gold)" : "var(--muted-foreground)"}
              />
              <span
                style={{
                  fontSize: 11.5,
                  letterSpacing: 0.3,
                  textTransform: "uppercase",
                  color: listening ? "var(--brand-gold)" : "var(--muted-foreground)",
                }}
              >
                {listening ? "Listening" : frame >= 92 ? "Working" : "Orchestrator"}
              </span>
            </div>
            <Waveform active={listening} />
            <p
              style={{
                margin: 0,
                minHeight: 40,
                maxWidth: 440,
                textAlign: "center",
                fontSize: 15,
                lineHeight: 1.5,
                color: "var(--foreground)",
              }}
            >
              {transcript}
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 520 }}>
            {ACTIONS.map((action) => {
              const step = spring({
                frame: frame - action.at,
                fps,
                config: { damping: 200 },
                durationInFrames: 16,
              });
              return (
                <div
                  key={action.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "8px 12px",
                    borderRadius: 9,
                    background: "var(--muted)",
                    opacity: step,
                    transform: `translateY(${interpolate(step, [0, 1], [6, 0])}px)`,
                  }}
                >
                  <span
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: "#34d399",
                    }}
                  >
                    <CheckIcon size={10} color="#04140d" strokeWidth={3} />
                  </span>
                  <span style={{ fontSize: 13 }}>{action.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </AppWindow>
  );
}
