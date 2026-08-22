import { interpolate, spring, useCurrentFrame, useVideoConfig } from "../motion";
import { AppWindow, Composer, MainHeader, Sidebar, type ThreadRowData } from "../ui/Shell";
import { CheckIcon, PanelIcon } from "../ui/icons";

const THREADS: readonly ThreadRowData[] = [
  { title: "Publish the release notes", project: "solla-code", age: "3m", active: true },
  { title: "Audit provider failover", project: "solla-code", age: "12m" },
];

/** The surfaces a signed host URL reaches, in the order the scene reveals them. */
const SURFACES: readonly { readonly at: number; readonly name: string; readonly via: string }[] = [
  { at: 108, name: "This desktop", via: "local" },
  { at: 124, name: "Laptop on the LAN", via: "192.168.1.24" },
  { at: 140, name: "Phone over Tailscale", via: "relay" },
];

export function ThreadArtifacts() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 25 });

  // Revision 2 replaces revision 1 in place, which is the point: artifacts are
  // revisioned rather than re-published as a new thing.
  const revision = frame > 74 ? 2 : 1;
  const cardIn = spring({ frame: frame - 30, fps, config: { damping: 200 }, durationInFrames: 20 });
  const bump = spring({ frame: frame - 74, fps, config: { damping: 140 }, durationInFrames: 14 });

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
        <MainHeader project="solla-code" title="Publish the release notes" />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: "6px 22px 14px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 14,
          }}
        >
          <div style={{ alignSelf: "flex-end", maxWidth: "70%" }}>
            <div
              style={{
                borderRadius: 12,
                background: "var(--muted)",
                padding: "9px 13px",
                fontSize: 13.5,
                lineHeight: 1.5,
              }}
            >
              Publish these as an artifact I can open on my phone.
            </div>
          </div>

          <div
            style={{
              maxWidth: 470,
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "var(--card)",
              overflow: "hidden",
              opacity: cardIn,
              transform: `translateY(${interpolate(cardIn, [0, 1], [10, 0])}px)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "11px 13px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background: "linear-gradient(150deg,#e8c877,#c89b3c 60%,#8d6a22)",
                  color: "#191308",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                S
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Release notes 0.1.181</div>
                <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                  markdown · revision {revision} · signed host URL
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 19,
                  padding: "0 8px",
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--brand-gold) 20%, transparent)",
                  color: "var(--brand-gold)",
                  fontSize: 11,
                  fontWeight: 600,
                  // A small pop when revision 2 lands, so the update is legible.
                  transform: `scale(${1 + bump * 0.12 * (revision === 2 ? 1 : 0)})`,
                }}
              >
                v{revision}
              </span>
            </div>
            <div style={{ padding: "12px 13px", display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                "Voice orchestrator with per-provider credentials",
                "Persistent terminal workspaces and auto-resume",
                "Custom agents, tasks, and bounded collaboration",
              ].map((line) => (
                <div key={line} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 999,
                      marginTop: 7,
                      background: "var(--muted-foreground)",
                    }}
                  />
                  <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>{line}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {SURFACES.map((surface) => {
              const step = spring({
                frame: frame - surface.at,
                fps,
                config: { damping: 200 },
                durationInFrames: 16,
              });
              return (
                <div
                  key={surface.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "6px 11px",
                    borderRadius: 999,
                    border: "1px solid var(--border)",
                    background: "var(--card)",
                    opacity: step,
                    transform: `translateY(${interpolate(step, [0, 1], [6, 0])}px)`,
                  }}
                >
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
                  <PanelIcon size={13} color="var(--muted-foreground)" />
                  <span style={{ fontSize: 12 }}>{surface.name}</span>
                  <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                    {surface.via}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <Composer placeholder="Revise the artifact, or publish another from this thread" />
      </main>
    </AppWindow>
  );
}
