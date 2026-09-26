import { RegistryContext } from "@effect/atom-react";
import { PreviewTabId, type PreviewTabAudioEvent, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { Volume2Icon, VolumeIcon, VolumeXIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { canPlayTabAudio, createTabAudioPlayer } from "./tabAudioPlayback";
import { usePreviewPageVisible } from "./previewPageVisibility";

/** How often a listening device reports what its player did. */
const TAB_AUDIO_REPORT_INTERVAL_MS = 5_000;

/** Whether this device plays the sound of browser tabs it views remotely. */
const REMOTE_TAB_SOUND_STORAGE_KEY = "solla:remote-tab-sound:v1";

/**
 * Opens a tab-audio subscription and hands over every event, in order.
 *
 * `immediate` is what opens it: a registry subscription alone only waits for
 * the atom to change, and a stream atom nobody has read never starts its
 * stream. Without it the phone sat on a subscription that never reached the
 * server, and the desktop, never asked, captured nothing (0.1.659).
 */
export function listenToTabAudio<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<PreviewTabAudioEvent>, E>>,
  onEvent: (event: PreviewTabAudioEvent) => void,
): () => void {
  let lastBatch: ReadonlyArray<PreviewTabAudioEvent> | null = null;
  return registry.subscribe(
    atom,
    (result) => {
      // A batch is one arrival. Waiting flags and completion re-announce the
      // same value, and playing it twice would stutter.
      if (!AsyncResult.isSuccess(result) || result.value === lastBatch) return;
      lastBatch = result.value;
      for (const event of result.value) onEvent(event);
    },
    { immediate: true },
  );
}

export type RemoteTabAudioState =
  | "unsupported"
  | "off"
  /** Sound is on but the tab is quiet. */
  | "quiet"
  /** The tab is making sound, but this device needs a tap before it may play. */
  | "tap-to-hear"
  | "playing";

/**
 * Listens to a remote browser tab's sound while it is worth hearing: sound
 * turned on for this device, the tab on screen, and the page itself visible.
 * The desktop only sends anything while the tab actually makes sound, so a
 * listening viewer of a quiet page costs one idle subscription.
 */
export function useRemoteTabAudio(input: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
}) {
  const supported = canPlayTabAudio();
  const [enabled, setEnabled] = useLocalStorage(REMOTE_TAB_SOUND_STORAGE_KEY, true, Schema.Boolean);
  const visible = usePreviewPageVisible();
  const listening = supported && enabled && input.visible && visible;
  const [playing, setPlaying] = useState(false);
  const [tabAudible, setTabAudible] = useState(false);
  const tabAudibleRef = useRef(false);
  const [unlocked, setUnlocked] = useState(false);
  const [player] = useState(() =>
    supported ? createTabAudioPlayer({ onPlayingChange: setPlaying }) : null,
  );
  useEffect(() => () => player?.dispose(), [player]);

  const registry = useContext(RegistryContext);
  const { environmentId, threadId } = input.threadRef;
  const reportPlayback = useAtomCommand(previewEnvironment.tabAudioReport, {
    reportFailure: false,
  });
  const reportPlaybackRef = useRef(reportPlayback);
  reportPlaybackRef.current = reportPlayback;
  useEffect(() => {
    if (!listening || !player) return;
    const noteAudible = (audible: boolean) => {
      if (tabAudibleRef.current === audible) return;
      tabAudibleRef.current = audible;
      setTabAudible(audible);
    };
    const atom = previewEnvironment.tabAudio({
      environmentId,
      input: { threadId, tabId: PreviewTabId.make(input.tabId) },
    });
    const unsubscribe = listenToTabAudio(registry, atom, (event) => {
      noteAudible(event.type === "audible" ? event.audible : true);
      player.handle(event);
    });
    // Only this device knows whether relayed sound actually played, so it
    // tells the server now and then (only when something changed) and once
    // on leaving. The server keeps it in its trace for diagnosis.
    const tabId = PreviewTabId.make(input.tabId);
    let lastReported = "";
    const report = () => {
      const { lastError, ...stats } = player.stats();
      const key = JSON.stringify([stats, lastError]);
      if (key === lastReported || stats.batches === 0) return;
      lastReported = key;
      void reportPlaybackRef.current({
        environmentId,
        input: {
          threadId,
          tabId,
          ...stats,
          ...(lastError === null ? {} : { lastError }),
        },
      });
    };
    const reporter = setInterval(report, TAB_AUDIO_REPORT_INTERVAL_MS);
    return () => {
      clearInterval(reporter);
      report();
      unsubscribe();
      noteAudible(false);
      player.handle({ type: "audible", audible: false });
    };
  }, [environmentId, input.tabId, listening, player, registry, threadId]);

  const unlock = () => {
    if (!player || !enabled) return;
    player.unlock();
    setUnlocked(true);
  };

  // iOS suspends sound when the page goes to the background; it needs a tap
  // again afterwards, which is exactly when "tap to hear" should come back.
  const soundAllowed = unlocked && (player?.unlocked ?? false);
  const state: RemoteTabAudioState = !supported
    ? "unsupported"
    : !enabled
      ? "off"
      : playing
        ? "playing"
        : tabAudible && !soundAllowed
          ? "tap-to-hear"
          : "quiet";

  return {
    state,
    /** Any tap on the page counts: pressing play on a video is the usual one. */
    unlockFromGesture: unlock,
    toggle: () => {
      if (!enabled) {
        setEnabled(true);
        player?.unlock();
        setUnlocked(true);
        return;
      }
      if (state === "tap-to-hear") {
        unlock();
        return;
      }
      setEnabled(false);
    },
  };
}

const LABELS: Record<RemoteTabAudioState, string> = {
  unsupported: "Tab sound needs a newer browser (Safari 26 or later)",
  off: "Tab sound is off. Turn it on",
  quiet: "Tab sound is on. Turn it off",
  "tap-to-hear": "The tab is playing sound. Tap to hear it",
  playing: "Playing the tab's sound. Turn it off",
};

/** The mirror strip's speaker: on/off for this device, and "tap to hear". */
export function RemoteTabAudioButton(props: {
  readonly state: RemoteTabAudioState;
  readonly onToggle: () => void;
}) {
  const { state } = props;
  const Icon =
    state === "off" || state === "unsupported"
      ? VolumeXIcon
      : state === "quiet"
        ? VolumeIcon
        : Volume2Icon;
  return (
    <button
      aria-label={LABELS[state]}
      aria-pressed={state !== "off" && state !== "unsupported"}
      title={LABELS[state]}
      data-remote-tab-audio={state}
      disabled={state === "unsupported"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm disabled:opacity-50",
        state === "playing"
          ? "border-gold-500/60 text-gold-600 dark:text-gold-400"
          : state === "tap-to-hear"
            ? "border-amber-500/50 text-amber-700 dark:text-amber-300"
            : "border-border text-muted-foreground",
      )}
      type="button"
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onToggle}
    >
      <Icon aria-hidden className="size-4" />
      {state === "tap-to-hear" ? <span>Tap to hear</span> : null}
    </button>
  );
}
