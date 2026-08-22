import { AudioLinesIcon, LoaderIcon, MicIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useOrchestratorSessionContext } from "../../orchestrator/OrchestratorSessionProvider";
import { smoothBubbleScale } from "../../orchestrator/bubblePresentation";
import {
  createVoiceSpeakerResolver,
  describeMobileVoice,
  resolveVoiceSpeaker,
  shouldShowVoiceOverlay,
  voiceOrbIntensity,
  type VoiceSpeaker,
} from "../../orchestrator/mobilePresentation";
import type { VoiceSessionState } from "../../orchestrator/realtimeSession";

/**
 * A full-screen surface over the app while the orchestrator has the microphone.
 *
 * An open microphone is easy to forget about — the orb alone is a 56-pixel dot
 * beside a sidebar, and the reported experience was talking to something with
 * no idea whether it was listening. Covering the app while a session is live
 * makes the state impossible to miss and gives the transcript somewhere to go
 * that is legible from across a room.
 *
 * **Handhelds only.** On a desktop this took the screen away from the very work
 * the user was talking about, to say something the floating bubble already says
 * without owning anything. See `shouldShowVoiceOverlay`.
 *
 * Click-through is deliberate on the backdrop: the overlay is an indicator, not
 * a modal, and the user must be able to keep reading the thread underneath while
 * they talk about it.
 */
export function OrchestratorListeningOverlay() {
  const session = useOrchestratorSessionContext();
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptLength = session?.transcript.length ?? 0;
  // Re-checked on resize: rotating a tablet, or dragging a browser window
  // across a screen boundary, changes the answer.
  const [overlayAllowed, setOverlayAllowed] = useState(() => shouldShowVoiceOverlay());

  useEffect(() => {
    const update = () => setOverlayAllowed(shouldShowVoiceOverlay());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Follow the conversation without the user having to reach for the screen.
  // Hooks run before the early returns below, so this cannot be moved down.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcriptLength]);

  if (session === null || !overlayAllowed) return null;

  // Connecting is deliberately included: the microphone is already open by the
  // time the session is configured, so hiding the overlay until "listening"
  // would leave the one moment the user most needs to see it uncovered.
  const live =
    session.state === "listening" || session.state === "speaking" || session.state === "connecting";
  if (!live) return null;

  const presentation = describeMobileVoice({
    state: session.state,
    canStart: session.canStart,
    canInterrupt: session.canInterrupt,
    working: session.working,
    error: session.error,
  });
  // The whole conversation, not a tail: the list scrolls now, and capping it at
  // six entries meant scrolling back simply had nothing to find.
  const recent = session.transcript;

  return (
    <div
      // Non-interactive by default so the app underneath keeps working; the
      // controls below re-enable pointer events for themselves.
      className="pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center gap-8 bg-black/70 backdrop-blur-sm"
      aria-live="polite"
    >
      <VoiceOrbKeyframes />
      <div className="flex flex-col items-center gap-4">
        <VoiceOrb
          state={session.state}
          working={session.working}
          subscribeLevels={session.subscribeLevels}
        />
        <p className="text-2xl font-medium text-white">{presentation.title}</p>
        {presentation.hint.length > 0 ? (
          <p className="max-w-sm text-center text-sm text-white/70">{presentation.hint}</p>
        ) : null}
      </div>

      {recent.length > 0 ? (
        // `pointer-events-auto` is not optional here: the backdrop above is
        // deliberately click-through, and without re-enabling events on this
        // list a touch drag passes straight through it, so the transcript
        // cannot be scrolled at all. `overscroll-contain` keeps that drag from
        // chaining to the page underneath once it reaches an end.
        <div className="pointer-events-auto flex max-h-[32vh] w-full max-w-xl flex-col gap-2 overflow-y-auto overscroll-contain px-6">
          {recent.map((entry, index) => (
            <div
              // Append-only and never reordered, so the index is stable identity;
              // entries carry no id of their own.
              // oxlint-disable-next-line react/no-array-index-key
              key={`${index}-${entry.role}`}
              className={[
                "rounded-2xl px-4 py-2 text-sm",
                entry.role === "user"
                  ? "ml-auto max-w-[85%] bg-white/15 text-white"
                  : "mr-auto max-w-[85%] bg-white/5 text-white/90",
              ].join(" ")}
            >
              {entry.text}
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => session.stop()}
        className="pointer-events-auto rounded-full bg-white/15 px-6 py-3 text-sm font-medium text-white hover:bg-white/25"
      >
        Stop listening
      </button>
    </div>
  );
}
/**
 * The overlay's orb: who is talking, how loudly, and what it is doing.
 *
 * Levels arrive at animation-frame rate, so this subscribes and writes styles
 * onto the node directly rather than putting them through React — sixty
 * re-renders a second to move one shadow is not a trade worth making. The
 * component itself only re-renders when the *speaker* changes, which is a few
 * times a conversation.
 */
export function VoiceOrb({
  state,
  working = false,
  subscribeLevels,
}: {
  state: VoiceSessionState;
  /** The assistant is mid-tool-call: holding the floor with nothing audible. */
  working?: boolean;
  subscribeLevels: (
    listener: (levels: { readonly mic: number; readonly assistant: number }) => void,
  ) => () => void;
}) {
  const orbRef = useRef<HTMLDivElement | null>(null);
  // Seeded from the state rather than hardcoded to `idle`: the first frame is
  // rendered before any level has arrived, and a connecting session that opens
  // as an idle-purple microphone is wrong in exactly the moment the overlay is
  // there to explain. The loop below refines it once levels start.
  const [speaker, setSpeaker] = useState<VoiceSpeaker>(() =>
    resolveVoiceSpeaker({ state, micLevel: 0, assistantLevel: 0, working }),
  );
  // Read inside the animation loop without making them dependencies; re-running
  // the loop on every change would restart the smoothing mid-swell.
  const stateRef = useRef(state);
  stateRef.current = state;
  const workingRef = useRef(working);
  workingRef.current = working;

  useEffect(() => {
    let levels = { mic: 0, assistant: 0 };
    let scale = 1;
    let frame: number | null = null;
    let currentSpeaker: VoiceSpeaker = resolveVoiceSpeaker({
      state: stateRef.current,
      micLevel: 0,
      assistantLevel: 0,
      working: workingRef.current,
    });
    // Held, not raw: raw resolution flips speaker on every inter-word level
    // dip, which strobed the icon while the assistant talked.
    const resolveSpeaker = createVoiceSpeakerResolver();

    const unsubscribe = subscribeLevels((next) => {
      levels = next;
    });

    const tick = () => {
      const nextSpeaker = resolveSpeaker(
        {
          state: stateRef.current,
          micLevel: levels.mic,
          assistantLevel: levels.assistant,
          working: workingRef.current,
        },
        performance.now(),
      );
      if (nextSpeaker !== currentSpeaker) {
        currentSpeaker = nextSpeaker;
        setSpeaker(nextSpeaker);
      }

      const intensity = voiceOrbIntensity({
        speaker: nextSpeaker,
        micLevel: levels.mic,
        assistantLevel: levels.assistant,
      });
      // The same response curve the desktop orb uses, so the two surfaces move
      // alike rather than each having their own feel.
      scale = smoothBubbleScale(scale, 1 + intensity * 0.55);
      const node = orbRef.current;
      if (node !== null) {
        node.style.transform = `scale(${scale.toFixed(3)})`;
        node.style.opacity = `${(0.72 + intensity * 0.28).toFixed(3)}`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [subscribeLevels]);

  const palette = ORB_PALETTE[speaker];

  return (
    <div className="relative flex size-44 items-center justify-center">
      {/* Behind the orb and unscaled, so a halo that grows with the voice does
          not drag the icon's size with it.

          A radial gradient, never `filter: blur()`: WebKit clips a blurred
          layer to its square bounds when it sits inside a `backdrop-filter`
          ancestor (the overlay's dimmed backdrop), which rendered the halo as
          a hard-edged square behind the orb on iOS and Android WebViews. A
          gradient is round by construction and needs no filter at all. */}
      <div
        aria-hidden="true"
        data-voice-halo
        className={[
          "absolute -inset-10 transition-opacity duration-500",
          palette.halo,
          speaker === "waiting" || speaker === "connecting"
            ? "animate-[orchestrator-orb-breathe_1.8s_ease-in-out_infinite]"
            : "",
        ].join(" ")}
      />
      <div
        ref={orbRef}
        data-voice-speaker={speaker}
        className={[
          "flex size-40 items-center justify-center rounded-full",
          "transition-[background-color,box-shadow] duration-500",
          palette.body,
          palette.glow,
        ].join(" ")}
        style={{ willChange: "transform, opacity" }}
      >
        <span className="text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.45)]">
          {speaker === "assistant" ? (
            <AudioLinesIcon size={44} strokeWidth={1.9} />
          ) : speaker === "waiting" || speaker === "connecting" ? (
            <LoaderIcon
              size={44}
              strokeWidth={1.9}
              className="animate-[orchestrator-orb-spin_1.2s_linear_infinite]"
            />
          ) : (
            <MicIcon size={44} strokeWidth={1.9} />
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * One colour per speaker, so a glance answers "who has the floor".
 *
 * Before this the orb was one colour at two opacities across every state, which
 * meant the surface whose entire job is showing what the session is doing could
 * not distinguish the assistant talking from the room being silent.
 */
const ORB_PALETTE: Record<VoiceSpeaker, { body: string; halo: string; glow: string }> = {
  // The user has the floor: warm, and the only state that is *their* colour.
  user: {
    body: "bg-emerald-400",
    halo: "bg-[radial-gradient(closest-side,rgba(52,211,153,0.4),transparent)]",
    glow: "shadow-[0_0_90px_-10px_rgb(52_211_153)]",
  },
  // The assistant answering, matching the accent used for it elsewhere.
  assistant: {
    body: "bg-violet-500",
    halo: "bg-[radial-gradient(closest-side,rgba(139,92,246,0.4),transparent)]",
    glow: "shadow-[0_0_110px_-10px_rgb(139_92_246)]",
  },
  // Working with nothing audible — the "let me check that…" pause.
  waiting: {
    body: "bg-sky-500",
    halo: "bg-[radial-gradient(closest-side,rgba(14,165,233,0.35),transparent)]",
    glow: "shadow-[0_0_80px_-16px_rgb(14_165_233)]",
  },
  connecting: {
    body: "bg-slate-500",
    halo: "bg-[radial-gradient(closest-side,rgba(100,116,139,0.3),transparent)]",
    glow: "shadow-[0_0_60px_-20px_rgb(100_116_139)]",
  },
  // Open and listening, but nobody is talking. Deliberately the quietest of
  // the five: an idle microphone should not look like an active one.
  idle: {
    body: "bg-violet-500/55",
    halo: "bg-[radial-gradient(closest-side,rgba(139,92,246,0.2),transparent)]",
    glow: "shadow-[0_0_70px_-24px_rgb(139_92_246)]",
  },
};

/**
 * Keyframes the orb needs, scoped to this surface.
 *
 * Inline rather than in the global sheet because the overlay is the only thing
 * that uses them and it is not always mounted; a global rule for a component
 * that exists on handhelds only is a rule nobody can find later.
 */
function VoiceOrbKeyframes() {
  return (
    <style>{`
      @keyframes orchestrator-orb-breathe {
        0%, 100% { opacity: 0.45; transform: scale(0.96); }
        50% { opacity: 0.85; transform: scale(1.04); }
      }
      @keyframes orchestrator-orb-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `}</style>
  );
}
