/* oxlint-disable react/iframe-missing-sandbox -- This trusted local fixture needs same-origin modules and DOM inspection for interaction checks. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioLinesIcon, MicIcon, MicOffIcon, LoaderIcon } from "lucide-react";
import { GalacticOrb, type OrbTint } from "../src/components/orchestrator/GalacticOrb";
import "./orb-preview.css";
import { usePreviewVoiceLevel } from "./usePreviewVoiceLevel";
import { computeBubbleScale } from "../src/orchestrator/bubblePresentation";

function Preview() {
  const [tint, setTint] = useState<OrbTint>("assistant");
  const [active, setActive] = useState(true);
  const level = usePreviewVoiceLevel(active && (tint === "user" || tint === "assistant"));
  const scale = computeBubbleScale({
    status: tint === "assistant" ? "speaking" : "listening",
    micLevel: tint === "user" ? level : 0,
    assistantLevel: tint === "assistant" ? level : 0,
  });
  const Icon =
    tint === "user"
      ? MicIcon
      : tint === "assistant"
        ? AudioLinesIcon
        : tint === "waiting" || tint === "connecting"
          ? LoaderIcon
          : MicOffIcon;
  return (
    <main>
      <header>
        <span className="wordmark">✦ SOLLA CODE</span>
        <span className="eyebrow">VOICE / 01</span>
      </header>
      <section className="intro">
        <p className="eyebrow">A LITTLE UNIVERSE, WITHIN REACH</p>
        <h1>Meet your galaxy.</h1>
        <p>
          Nebula clouds flow. Starlight shimmers.
          <br />
          The sphere swells and settles with every phrase.
        </p>
      </section>
      <section className="stage">
        <GalacticOrb
          size={128}
          tint={tint}
          animated={active}
          spinning={tint !== "idle"}
          intensity={level}
          scale={scale}
        >
          <Icon size={28} strokeWidth={1.6} />
        </GalacticOrb>
        <span className="caption">
          {tint === "idle"
            ? "Ready when you are"
            : tint === "user"
              ? "Listening to you"
              : tint === "assistant"
                ? "Speaking"
                : tint === "waiting"
                  ? "Thinking"
                  : tint === "connecting"
                    ? "Connecting"
                    : "Needs attention"}
        </span>
      </section>
      <div className="states">
        {(["idle", "user", "assistant", "waiting", "connecting", "error"] as const).map((state) => (
          <button key={state} aria-pressed={tint === state} onClick={() => setTint(state)}>
            {
              {
                idle: "At rest",
                user: "Listening",
                assistant: "Speaking",
                waiting: "Thinking",
                connecting: "Connecting",
                error: "Error",
              }[state]
            }
          </button>
        ))}
      </div>
      <button className="motion" aria-pressed={active} onClick={() => setActive((value) => !value)}>
        {active ? "Pause motion & voice pulse" : "Play motion & voice pulse"}
      </button>
      <section className="details">
        <div>
          <p className="eyebrow">DESKTOP / ACTUAL SIZE</p>
          <h2>
            Small presence.
            <br />
            Whole universe.
          </h2>
          <p>
            The floating orb rests at 56 pixels.
            <br />
            Hover and click the orb beside this text
            <br />
            to try its hint and simulated voice state.
          </p>
          <p className="fine">This preview does not access your microphone.</p>
        </div>
        <iframe
          title="Interactive floating orb"
          src="/dev/orb-bubble.html"
          width="288"
          height="288"
        />
      </section>
      <footer>VIOLET NEBULA · CYAN STARLIGHT · GLASS FINISH</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
