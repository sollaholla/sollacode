import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { BlackHoleOrb, resolveVoiceOrbTint } from "../components/orchestrator/BlackHoleOrb";
import { useOrchestratorSessionContext } from "../orchestrator/OrchestratorSessionProvider";
import type { VoiceSessionState } from "../orchestrator/realtimeSession";
import {
  computeMobileOrbDiameter,
  computeMobileOrbScale,
  describeMobileVoice,
} from "../orchestrator/mobilePresentation";

/**
 * The orchestrator as a full screen, for a phone.
 *
 * The desktop surfaces the voice session as a small orb beside a sidebar full of
 * threads. None of that survives a 390-point-wide screen held one-handed on a
 * walk, and the sidebar is not what the user wants there anyway: they want to
 * talk, hear the answer, and put the phone back in their pocket.
 *
 * Deliberately a *web* route rather than a native screen. The voice session is
 * WebRTC talking straight to OpenAI, and it already exists here — tools, thread
 * routing, the language pin, waking on awaited work, ending by voice. Loading
 * this route on a phone, whether in a browser or hosted in the mobile app's
 * WebView, reuses all of it and puts the microphone and the audio on the phone,
 * which is the only arrangement that helps someone wearing headphones.
 */
export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorFullScreenView,
});

function OrchestratorFullScreenView() {
  const session = useOrchestratorSessionContext();
  const [orbDiameter, setOrbDiameter] = useState(() =>
    computeMobileOrbDiameter(
      typeof window === "undefined" ? 360 : Math.min(window.innerWidth, window.innerHeight),
    ),
  );
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () =>
      setOrbDiameter(computeMobileOrbDiameter(Math.min(window.innerWidth, window.innerHeight)));
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Follow the conversation without the user having to reach for the screen.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.transcript.length]);

  if (session === null) return null;

  const presentation = describeMobileVoice({
    state: session.state,
    canStart: session.canStart,
    canInterrupt: session.canInterrupt,
    working: session.working,
    error: session.error,
  });
  const scale = computeMobileOrbScale(0, presentation.live);

  return (
    <div className="bg-background text-foreground flex h-[100dvh] w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between px-5 pt-[env(safe-area-inset-top)]">
        <div className="pt-4 pb-2">
          <h1 className="text-lg font-semibold">Orchestrator</h1>
          {session.activeModel !== null ? (
            <p className="text-muted-foreground text-xs">{session.activeModel}</p>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
        <button
          type="button"
          aria-label={presentation.actionLabel}
          onClick={() => session.toggle()}
          // Sized off the viewport rather than a fixed value: the only control on
          // the screen should be hittable without looking at it.
          style={{
            width: orbDiameter,
            height: orbDiameter,
            transform: `scale(${scale})`,
          }}
          className="flex items-center justify-center rounded-full outline-hidden transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          <BlackHoleOrb
            size={orbDiameter}
            tint={resolveVoiceOrbTint(session.state, session.working, presentation.live)}
            spinning={presentation.live}
            breathing={session.state === "connecting" || session.working}
            intensity={presentation.live ? 0.6 : 0}
          >
            <span className="text-2xl font-medium">{presentation.live ? "Stop" : "Talk"}</span>
          </BlackHoleOrb>
        </button>

        <div className="text-center">
          <p className="text-xl font-medium" aria-live="polite">
            {presentation.title}
          </p>
          {presentation.hint.length > 0 ? (
            <p className="text-muted-foreground mt-1 max-w-xs text-sm">{presentation.hint}</p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[max(env(safe-area-inset-bottom),1rem)]">
        {session.transcript.map((entry, index) => (
          <div
            // The transcript is append-only and never reordered — entries are
            // pushed and the tail is dropped — so the index is a stable identity
            // here. Entries carry no id of their own to use instead.
            // oxlint-disable-next-line react/no-array-index-key
            key={`${index}-${entry.role}`}
            className={[
              "mb-2 rounded-2xl px-4 py-2 text-sm",
              entry.role === "user"
                ? "bg-muted ml-auto max-w-[85%]"
                : "bg-card mr-auto max-w-[85%]",
            ].join(" ")}
          >
            {entry.text}
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>
    </div>
  );
}

/**
 * The orb's colour for the full-screen route, which has no per-frame levels:
 * the session state alone says who has the floor.
 */
