import {
  OPENAI_REALTIME_CALLS_URL,
  ORCHESTRATOR_REALTIME_TOKEN_PATH,
  type OrchestratorAuthority,
  type OrchestratorVoiceProvider,
  buildXaiRealtimeWebsocketUrl,
  xaiClientSecretProtocol,
} from "@t3tools/contracts";
import {
  REALTIME_PCM_SAMPLE_RATE,
  createStreamingLinearResampler,
  float32ToPcm16Base64,
  pcm16Base64ToFloat32,
  resampleLinear,
} from "./pcmAudio";

import {
  buildAnnouncementInstructions,
  buildCancelResponseFrames,
  buildDiscardResponseFrames,
  buildToolReplyInstructions,
  buildInterruptFrames,
  buildResponseCreateFrame,
  buildSessionUpdate,
  buildToolOutputFrame,
  describeNegotiationFailure,
  isResponseCollisionError,
  isLikelyEchoFragment,
  isLikelyHallucinatedTranscript,
  parseRealtimeEvent,
  parseToolArguments,
  type RecentConversationEntry,
} from "./realtimeProtocol";
import { BARGE_IN_SUSTAIN_MS, createBargeInWindow, type BargeInWindow } from "./bargeIn";
import { decideEndOfSpeech } from "./endOfSpeech";
import {
  GROK_UTTERANCE_SETTLE_MS,
  UTTERANCE_SETTLE_MS,
  shouldCommitUtterance,
  type BufferedUtterance,
  type FlushedUtterance,
} from "./utteranceCoalesce";
import { applyVoiceIsolation, microphoneConstraints } from "./voiceIsolation";
import {
  DISCONNECTED_GRACE_MS,
  isConnectionLostState,
  isConnectionUnstableState,
} from "./reconnect";
import {
  createVoiceCuePlayer,
  mayPlayCue,
  shouldPlayThinkingCue,
  type VoiceCue,
  type VoiceCuePlayer,
  type VoiceCuePolicy,
} from "./voiceCues";
import type { RealtimeUsage } from "./usageTracking";

/** How often the silence watch checks; well under any sensible timeout. */
const IDLE_POLL_INTERVAL_MS = 2_000;
/**
 * How often the microphone's half-duplex gate is reconciled off the clock.
 *
 * Deliberately slow. This is a backstop for the frames that never arrive while
 * the page is hidden, not a second echo guard — timers are throttled in the
 * background anyway, so anything faster would be a promise the platform does
 * not keep.
 */
const FLOOR_RECONCILE_INTERVAL_MS = 2_000;
/** Mic level that counts as "not silence" for the idle watch. */
const IDLE_ACTIVE_LEVEL = 0.08;
/**
 * Output level at which the assistant counts as audibly speaking.
 *
 * A measurement rather than a server event on purpose. Everything protecting the
 * user from the assistant's own echo keys off "is it speaking right now", and
 * knowing that from `output_audio_buffer.started` alone means a browser that
 * never delivers those events silently disables all of it. The remote track is
 * already being metered for the orb, so this reads the answer off the audio.
 */
const ASSISTANT_AUDIBLE_LEVEL = 0.04;
/**
 * How long after the last audible frame the assistant is still treated as
 * speaking. Covers the gaps between words without stretching so far that a real
 * reply gets caught — the server needs a sustained pause before it starts one,
 * which is far longer than this.
 */
export const ASSISTANT_AUDIO_GRACE_MS = 600;

/**
 * Whether the assistant can currently be heard.
 *
 * Prefers the server's output-buffer events and falls back to when the remote
 * track was last measurably audible. Split out from the session so the fallback
 * is testable: it exists precisely for the case where those events never
 * arrive, which is the hardest thing to reproduce and the easiest to break.
 *
 * `lastAudibleAt` of 0 means the track has never been audible — with no
 * metering attached this reduces to the buffer event alone.
 */
export function isAssistantAudible(input: {
  readonly bufferPlaying: boolean;
  readonly lastAudibleAt: number;
  readonly nowMs: number;
  readonly graceMs?: number;
}): boolean {
  if (input.bufferPlaying) return true;
  if (input.lastAudibleAt === 0) return false;
  return input.nowMs - input.lastAudibleAt < (input.graceMs ?? ASSISTANT_AUDIO_GRACE_MS);
}
/**
 * How long to wait for `session.updated` before opening the microphone anyway.
 * Long enough that the ack always wins on a working connection, short enough
 * that a server which stops sending it costs a pause rather than a dead mic.
 */
/**
 * Slack over the audio still queued before playback is declared broken.
 *
 * The session leaves "speaking" when every scheduled buffer reports `ended`.
 * That event comes from the audio hardware, and on a phone it simply stops
 * arriving: locking the screen, taking a call, or switching output route
 * suspends the AudioContext, and buffers scheduled into a suspended context
 * never reach their end time. Nothing else re-opens the microphone, so the
 * session sits on "Speaking" — deaf, with the reply already finished — until
 * it is stopped and started again.
 *
 * The deadline is computed from the queue rather than fixed, because we know
 * exactly how much audio is scheduled; this is only the margin on top.
 */
export const PLAYBACK_DRAIN_GRACE_MS = 2_000;

/**
 * Longest playback may continue after the server says the response is done.
 *
 * For the WebRTC transport the audio is on a media track we do not schedule,
 * so there is no queue length to compute a deadline from — only the knowledge
 * that whatever is still buffered when generation completes is measured in
 * seconds. Generous on purpose: firing early reopens the microphone into the
 * assistant's own voice, which is the failure this whole path exists to avoid.
 */
const TRACK_DRAIN_LIMIT_MS = 30_000;

const SESSION_CONFIGURE_TIMEOUT_MS = 3_000;
/**
 * Longest the waiting tone may sound before the wait is treated as broken.
 *
 * The tone means "the assistant has the floor, hold on". Every path that ends a
 * wait is an event from somewhere else — the server finishing a response, a
 * tool returning, the user starting to speak — so any one of them going missing
 * leaves it pulsing with nothing behind it. Reported as beeping "for minutes"
 * with no reply and no way back except stopping and restarting the session.
 *
 * The commonest cause is not a logic error at all: a phone that locks or takes
 * a call has its microphone muted by the operating system, so the user goes on
 * talking and the server hears silence — no speech-started event, so nothing
 * ever clears the wait. Output audio keeps playing throughout, which is why the
 * tone is audible while nothing else is.
 *
 * Comfortably above `TOOL_CALL_TIMEOUT_MS` so a slow-but-working tool call
 * always finishes first: this is a backstop, never part of normal timing.
 */
const WORKING_TONE_LIMIT_MS = 45_000;
/**
 * How long the capture track must stay muted before it is reported.
 * Long enough to ride out a device or route change, short enough that someone
 * talking into a dead microphone finds out while they are still talking.
 */
const MIC_SUSPEND_REPORT_MS = 1_200;

/**
 * Whether the first-word `heard` click is trustworthy on a provider.
 *
 * The click's entire value is consistency: it either reliably means "your
 * words are getting through" or it teaches nothing. OpenAI orders events so a
 * first delta before `speech_stopped` is dependable. Grok often delivers the
 * first delta *after* `speech_stopped`, which made the click fire on a coin
 * flip of event ordering — intermittent feedback is worse than none, so it is
 * off there entirely; `accepted` and the working pulse still confirm the turn.
 */
const HEARD_CUE_BY_PROVIDER: Record<OrchestratorVoiceProvider, "first-delta" | "off"> = {
  openai: "first-delta",
  xai: "off",
};

export type VoiceSessionState = "idle" | "connecting" | "listening" | "speaking" | "error";

export interface VoiceSessionLevels {
  /** Instantaneous microphone level, 0..1. */
  readonly mic: number;
  /** Instantaneous orchestrator playback level, 0..1. */
  readonly assistant: number;
}

export interface VoiceSessionCallbacks {
  readonly onStateChange?: (state: VoiceSessionState) => void;
  readonly onTranscript?: (entry: { role: "user" | "assistant"; text: string }) => void;
  readonly onError?: (message: string) => void;
  /**
   * Streamed at animation-frame rate while the session is live. Consumers that
   * forward this anywhere (IPC, state) must throttle it themselves.
   */
  readonly onLevels?: (levels: VoiceSessionLevels) => void;
  /** Executes a tool call and resolves with the JSON-serializable result. */
  readonly onToolCall: (call: { name: string; args: Record<string, unknown> }) => Promise<unknown>;
  /**
   * Reports what the server actually minted. Settings are read at mint time, so
   * this — not the settings value — is the model the session is really running,
   * and the two diverge whenever settings are edited mid-session.
   */
  readonly onSessionReady?: (info: { readonly model: string; readonly voice: string }) => void;
  /** A possible barge-in that turned out to be noise, and was not acted on. */
  readonly onNoiseIgnored?: () => void;
  /**
   * Whether the assistant holds the floor while making no sound — a tool call
   * between sentences, or the gap between the user's turn closing and the
   * answer starting.
   *
   * Deliberately not folded into {@link VoiceSessionState}: every other
   * consumer treats that as the session's mode, and "listening" is still true
   * of the session here. This is a presentation signal for surfaces that tell
   * the user whether they may speak — the floating orb showed an open
   * microphone through this entire window.
   */
  readonly onWorkingChange?: (working: boolean) => void;
  /** The session closed itself after the configured silence. */
  readonly onIdleTimeout?: () => void;
  /**
   * The transport went away — Wi-Fi dropped, or the peer failed. The session
   * is already torn down by the time this fires; the owner decides whether to
   * reconnect.
   */
  readonly onConnectionLost?: () => void;
  /** The user asked, out loud, for the session to end. */
  readonly onEndedByVoice?: () => void;
  /** Tokens a completed response consumed, straight from the API. */
  readonly onUsage?: (usage: RealtimeUsage) => void;
}

export interface VoiceSessionOptions {
  /** Base URL of the environment server that holds the API key. */
  readonly httpBaseUrl: string;
  /** Bearer token for remote environments; null uses the session cookie. */
  readonly bearerToken: string | null;
  readonly authority: OrchestratorAuthority;
  readonly confirmDestructiveActions: boolean;
  /** ISO-639-1 code pinned into instructions and input transcription. */
  readonly language: string;
  /** Recent thread exchanges folded into the opening instructions. */
  readonly recentHistory?: ReadonlyArray<RecentConversationEntry>;
  /**
   * Close the session after this many seconds with no speech from either side.
   * Omitted or zero leaves the microphone open indefinitely.
   */
  readonly silenceTimeoutSeconds?: number;
  /**
   * Whether speech over the top of the orchestrator cuts it off. Defaults to
   * true; false makes it always finish what it is saying.
   */
  readonly interruptWhileSpeaking?: boolean;
  /**
   * Runs the microphone through the noise gate before it is sent. Off unless
   * the user has turned it on — it sits in the outgoing audio path, so a fault
   * costs them their voice rather than merely degrading it.
   */
  readonly voiceIsolation?: boolean;
  /**
   * Whether cues sound, and how loud, consulted at each play. Omitted means
   * always on at designed volume — the setting is a client concern and this
   * module must keep working without one.
   */
  readonly cuePolicy?: () => VoiceCuePolicy;
}

export interface VoiceSession {
  start(): Promise<void>;
  stop(): void;
  /** Makes the orchestrator speak up unprompted. No-op unless connected. */
  announce(text: string): void;
  /**
   * Closes the session once the reply in flight has been spoken.
   *
   * Saying "that's all, thanks" and having the microphone die mid-goodbye reads
   * as a crash rather than a clean end, so the farewell is allowed to finish.
   * Falls back to closing immediately when nothing is being spoken.
   */
  endAfterReply(): void;
  /** Cuts off whatever is being said right now, and keeps listening. */
  hush(): void;
  readonly state: VoiceSessionState;
}

interface RealtimeTokenResponse {
  readonly value: string;
  readonly model: string;
  readonly voice: string;
  readonly provider?: OrchestratorVoiceProvider;
  readonly transport?: "webrtc" | "websocket";
  readonly realtimeUrl?: string;
}

/**
 * Ceiling on one tool call. Generous — a thread read over a slow link is
 * legitimately slow — but finite, because the session now waits on these.
 */
const TOOL_CALL_TIMEOUT_MS = 30_000;

/**
 * How long events are gathered before any of them is spoken.
 *
 * Short enough that a single event still feels immediate, long enough that a
 * cluster arriving together becomes one sentence rather than one interruption
 * each.
 */
const ANNOUNCEMENT_BATCH_MS = 1_200;

/**
 * Maximum distinct notices handed to the voice model in one batch.
 *
 * A reconnect or projection catch-up can legitimately produce dozens of
 * transitions at once. Reading every one is notification spam, and putting all
 * of them into one instruction still floods the model even though it produces
 * only one spoken response. Keep a useful sample and summarize the overflow.
 */
const MAX_ANNOUNCEMENTS_PER_BATCH = 8;

/** Bound the call-id ledger for a voice session that stays open all day. */
const MAX_HANDLED_TOOL_CALL_IDS = 256;

/** Initial PCM reserve used to absorb ordinary WebSocket delivery jitter. */
export const PCM_PLAYBACK_JITTER_RESERVE_MS = 60;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** RMS of a time-domain byte buffer, scaled into a UI-friendly 0..1. */
function readLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  if (buffer.length === 0) return 0;
  analyser.getByteTimeDomainData(buffer);
  let sumOfSquares = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const centered = ((buffer[index] ?? 128) - 128) / 128;
    sumOfSquares += centered * centered;
  }
  const rms = Math.sqrt(sumOfSquares / buffer.length);
  // Speech RMS rarely exceeds ~0.4; stretch so normal speech reads near 1.
  return Math.min(1, rms * 2.8);
}

/**
 * A speech-to-speech orchestrator session.
 *
 * The browser never sees the long-lived API key: it asks this environment's
 * server for a short-lived client secret, then talks to the selected backend
 * directly. OpenAI uses WebRTC; Grok Voice uses the xAI WebSocket documented
 * in the Speech-to-Speech API. Barge-in comes from the browser's own echo
 * cancellation — the desktop's `setPushToTalkSystemAudioMuted` path is
 * deliberately NOT used here, because it mutes all system output and would
 * mute the orchestrator's own voice.
 */
export function createVoiceSession(
  options: VoiceSessionOptions,
  callbacks: VoiceSessionCallbacks,
): VoiceSession {
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let socket: WebSocket | null = null;
  let captureProcessor: ScriptProcessorNode | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  /**
   * Whether PCM frames may go to Grok. Separate from `MediaStreamTrack.enabled`
   * because Chromium's `MediaStreamAudioSourceNode` stays silent for the rest
   * of the session if the track is disabled when the node is created, or is
   * disabled later and then re-enabled. Half-duplex and the config gate must
   * withhold audio here instead of muting the track.
   */
  let sendMicrophoneAudio = false;
  let playbackGain: GainNode | null = null;
  let nextPlayTime = 0;
  const playbackSources: AudioBufferSourceNode[] = [];
  let audioGenerationDone = false;
  /** See {@link PLAYBACK_DRAIN_GRACE_MS}. */
  let playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
  let onPlaybackDrained = () => undefined;
  let captureResampler: ReturnType<typeof createStreamingLinearResampler> | null = null;
  let voiceProvider: OrchestratorVoiceProvider = "openai";
  let pendingUserUtterance: BufferedUtterance | null = null;
  let lastCommittedUserUtterance: FlushedUtterance | null = null;
  let utteranceFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let micStream: MediaStream | null = null;
  /**
   * What is actually sent — the gate's output when isolation is on, otherwise
   * `micStream` itself. Tracked separately because muting has to reach the sent
   * track, not just the captured one.
   */
  let sentStream: MediaStream | null = null;
  let releaseIsolation: (() => void) | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let audioContext: AudioContext | null = null;
  let micAnalyser: AnalyserNode | null = null;
  let assistantAnalyser: AnalyserNode | null = null;
  let meterFrame: number | null = null;
  // Open only while a possible barge-in is being judged; the meter tick feeds it.
  let bargeInWindow: BargeInWindow | null = null;
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  /** See {@link startFloorWatch}. */
  let floorTimer: ReturnType<typeof setInterval> | null = null;
  // Held while the microphone is muted waiting for `session.updated`.
  let configureTimer: ReturnType<typeof setTimeout> | null = null;
  let configured = false;
  let lastActivityAt = Date.now();
  // True between speech_started and speech_stopped: the user is mid-utterance.
  let userSpeaking = false;
  // VAD has closed this utterance. Used so a late Grok transcript does not
  // play the "heard you" click after the floor is already down.
  let speechStoppedThisUtterance = false;
  let state: VoiceSessionState = "idle";
  // One-way latch. start() awaits a token fetch, getUserMedia, and SDP
  // negotiation; a stop() landing inside any of those windows would otherwise
  // be outrun by the continuation, which would go on to open a microphone and
  // a peer connection that nothing holds a handle to anymore.
  let stopped = false;
  // True once the peer has actually reached "connected". Until then there is no
  // connection to lose, and a state change is a negotiation problem rather than
  // a drop — see the connectionstatechange handler.
  let established = false;
  // Held while `disconnected` is being given a chance to recover.
  let unstableTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (next: VoiceSessionState) => {
    if (state === next) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const fail = (message: string) => {
    setState("error");
    callbacks.onError?.(message);
  };

  const clearUnstableWatch = () => {
    if (unstableTimer === null) return;
    clearTimeout(unstableTimer);
    unstableTimer = null;
  };

  /** A session that was up and is now gone. Hands off to the reconnect path. */
  const reportConnectionLost = () => {
    clearUnstableWatch();
    playCue("deaf");
    const notify = callbacks.onConnectionLost;
    stop();
    notify?.();
  };

  /**
   * Recovers a session the platform suspended while the app was in the
   * background.
   *
   * Locking a phone suspends the page and the WebRTC connection with it. The
   * screen wake lock stops the screen *timing out*, but it cannot stop someone
   * deliberately locking the device, and nothing in the platform keeps a voice
   * session alive once that happens. What the user saw was an orb that still
   * looked live answering nothing, and the only way out was stopping and
   * starting voice by hand.
   *
   * Coming back to a connection that is no longer up is exactly a drop, so it
   * is reported as one and the existing reconnect path takes it from there —
   * including the rising cue that means "you can talk now", which is the part
   * that makes a silent recovery legible.
   */
  const handleVisibilityChange = () => {
    if (stopped || typeof document === "undefined") return;
    if (document.hidden) {
      onPageHidden();
      return;
    }
    onPageVisible();
  };

  /**
   * Hands the floor back before the page is suspended.
   *
   * Half duplex closes the microphone while the assistant is audible, and the
   * decision to reopen it is made by the level meter — which runs on
   * `requestAnimationFrame` and therefore *stops entirely* when the phone
   * locks. Lock the phone while an answer is playing, which is the ordinary
   * case, and the microphone is left closed with the only thing that would have
   * reopened it no longer running. Unlock and talk, and nothing reaches the
   * server: voice looks live and hears nothing.
   *
   * While hidden the echo protection cannot function anyway — there are no
   * levels to protect against with — so a closed microphone protects nothing
   * and costs everything. The event-driven path (`speaking-started` /
   * `speaking-stopped`) keeps working over the data channel and stays in
   * charge; this only makes sure the meter's decision is not left latched.
   */
  const onPageHidden = () => {
    // A disconnect grace timer scheduled while visible can expire immediately
    // when a throttled page wakes, before ICE gets a chance to report recovery.
    // Visibility recovery below starts a fresh grace window if it is still
    // needed.
    clearUnstableWatch();
    if (!configured || !isHalfDuplex()) return;
    setMicrophoneEnabled(true);
  };

  /**
   * Recovers a session the platform suspended while the app was in the
   * background.
   *
   * Coming back to a connection that is really gone is exactly a drop, so it is
   * reported as one and the existing reconnect path takes it from there —
   * including the rising cue that means "you can talk now".
   *
   * Which states count is the whole of it, and getting that wrong is worse than
   * not checking at all. `disconnected` is transient *by specification*, and it
   * is what an unlocking phone reports for a second or two while ICE re-runs
   * its checks; reporting a drop on sight of it tore down sessions that were
   * about to recover on their own. This defers to the same grace the connection
   * handler uses rather than keeping a second opinion about it.
   */
  const onPageVisible = () => {
    if (socket !== null) {
      if (socket.readyState !== WebSocket.OPEN) reportConnectionLost();
      return;
    }
    const connection = peer;
    if (connection === null) return;
    const peerState = connection.connectionState;
    if (peerState === undefined) return;
    reconcileMicrophoneFloor();
    if (isConnectionLostState(peerState)) {
      reportConnectionLost();
      return;
    }
    if (!isConnectionUnstableState(peerState)) return;
    if (unstableTimer !== null) return;
    unstableTimer = setTimeout(() => {
      unstableTimer = null;
      if (stopped || connection.connectionState === "connected") return;
      reportConnectionLost();
    }, DISCONNECTED_GRACE_MS);
  };

  /**
   * Reopens the microphone once nothing is audible.
   *
   * Extracted from the level meter so it is not the only caller: everything the
   * meter does stops when the page is hidden, and "the microphone reopens" is
   * not something that may quietly depend on the screen being on.
   */
  const reconcileMicrophoneFloor = () => {
    if (stopped || !configured || !isHalfDuplex()) return;
    if (assistantAudible()) return;
    setMicrophoneEnabled(true);
  };

  const isDataOpen = () => socket?.readyState === WebSocket.OPEN || channel?.readyState === "open";

  const send = (frame: Record<string, unknown>) => {
    const payload = JSON.stringify(frame);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    if (channel?.readyState === "open") {
      channel.send(payload);
    }
  };

  const stopPlayback = () => {
    // Remove first so each source's asynchronous `onended` cannot mistake an
    // intentional cancellation for the natural drain of the playback queue.
    const sources = playbackSources.splice(0);
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    nextPlayTime = 0;
  };

  const stopXaiPlayback = () => {
    if (voiceProvider !== "xai" || !audioPlaying) return;
    stopPlayback();
    audioGenerationDone = true;
    onPlaybackDrained();
  };

  const playAudioDelta = (base64: string) => {
    try {
      audioContext ??= new AudioContext({ sampleRate: REALTIME_PCM_SAMPLE_RATE });
      void audioContext.resume();
      playbackGain ??= (() => {
        const gain = audioContext!.createGain();
        gain.connect(audioContext!.destination);
        if (callbacks.onLevels !== undefined) {
          const dest = audioContext!.createMediaStreamDestination();
          gain.connect(dest);
          attachAssistantMeter(dest.stream);
        }
        return gain;
      })();
      let samples = pcm16Base64ToFloat32(base64);
      if (samples.length === 0) return;
      if (audioContext.sampleRate !== REALTIME_PCM_SAMPLE_RATE) {
        samples = resampleLinear(samples, REALTIME_PCM_SAMPLE_RATE, audioContext.sampleRate);
      }
      const buffer = audioContext.createBuffer(1, samples.length, audioContext.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(playbackGain);
      source.addEventListener("ended", () => {
        const index = playbackSources.indexOf(source);
        if (index < 0) return;
        playbackSources.splice(index, 1);
        if (playbackSources.length === 0 && audioGenerationDone) onPlaybackDrained();
      });
      const now = audioContext.currentTime;
      nextPlayTime = Math.max(
        nextPlayTime,
        now + (playbackSources.length === 0 ? PCM_PLAYBACK_JITTER_RESERVE_MS / 1_000 : 0),
      );
      source.start(nextPlayTime);
      nextPlayTime += buffer.duration;
      playbackSources.push(source);
    } catch {
      // A dropped chunk is better than taking the session down.
    }
  };

  const startPcmCapture = (stream: MediaStream) => {
    audioContext ??= new AudioContext({ sampleRate: REALTIME_PCM_SAMPLE_RATE });
    void audioContext.resume();
    captureSource = audioContext.createMediaStreamSource(stream);
    captureProcessor = audioContext.createScriptProcessor(2048, 1, 1);
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    captureSource.connect(captureProcessor);
    captureProcessor.connect(silent);
    silent.connect(audioContext.destination);
    captureResampler = createStreamingLinearResampler(
      audioContext.sampleRate,
      REALTIME_PCM_SAMPLE_RATE,
    );
    captureProcessor.onaudioprocess = (event) => {
      if (stopped || !configured || !sendMicrophoneAudio) return;
      let samples = event.inputBuffer.getChannelData(0);
      if (audioContext !== null && audioContext.sampleRate !== REALTIME_PCM_SAMPLE_RATE) {
        samples = captureResampler?.process(samples) ?? samples;
      }
      send({ type: "input_audio_buffer.append", audio: float32ToPcm16Base64(samples) });
    };
  };

  // ── Response gate ──────────────────────────────────────────────
  // Exactly one `response.create` may be in flight. The API accepts a second
  // one as soon as the first finishes, so a turn that called four tools — and
  // the instructions demand `list_threads` before answering anything about
  // current state — used to queue four replies and the orchestrator answered
  // the same question four times over, rephrasing itself each round.
  let responseActive = false;
  let responseRequested = false;
  // Set by endAfterReply: close as soon as the current reply is out.
  let endWhenReplyFinishes = false;
  let pendingReplyRequested = false;
  /**
   * Tool calls that have been handed off and not yet answered.
   *
   * Counted rather than flagged: a turn can make several at once, and the
   * waiting tone has to keep sounding until the last of them comes back.
   */
  let toolCallsInFlight = 0;
  /**
   * Realtime providers may report one function call through more than one
   * completion event shape. The call id is the provider's idempotency key: a
   * duplicate must never execute its side effect again (especially settings
   * updates, which create an agent-facing marker message).
   */
  const handledToolCallIds = new Set<string>();
  /** Last value handed to `onWorkingChange`, so it only fires on a change. */
  let lastWorkingReported = false;
  let announcementBatchTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAnnouncements: Array<string> = [];
  const pendingAnnouncementKeys = new Set<string>();
  let omittedAnnouncementCount = 0;
  // True between output_audio_buffer.started and .stopped — i.e. while the user
  // can still hear the previous answer, which outlasts `response.done`.
  let audioPlaying = false;
  let flushWhenAudioDrains = false;
  /**
   * True while a reply is held back because the user's transcript trailed off
   * mid-thought. Cleared when they carry on, or when the grace elapses.
   */
  let awaitingContinuation = false;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stops a second hold on the same turn — see `decideEndOfSpeech`. */
  let heldForContinuation = false;
  let cuePlayer: VoiceCuePlayer | null = null;
  /**
   * True from the moment the user's turn is accepted until their answer is
   * audible (or the turn ends without one).
   *
   * This — not `isBusy()` — is what the waiting tone is gated on. Background
   * work makes the session busy too, and beeping through a thread finishing
   * would turn housekeeping into an alarm.
   */
  let awaitingUserAnswer = false;
  /** Guards the first-word click so it fires once per utterance, not per word. */
  let heardCuePlayedThisUtterance = false;
  /** See {@link WORKING_TONE_LIMIT_MS}. */
  let workingWatchdog: ReturnType<typeof setTimeout> | null = null;

  /**
   * Plays a state cue, but only when nobody else has the floor.
   *
   * Routed through one gate rather than checked at each call site so the rule —
   * never make a noise over the user — cannot be forgotten at a new one.
   */
  const ensureCuePlayer = () => {
    if (cuePlayer !== null) return;
    try {
      // Shares the meters' context rather than opening a second one: browsers
      // cap how many exist, and a phone that refuses the extra would lose the
      // level metering the echo protections depend on.
      audioContext ??= new AudioContext();
      cuePlayer = createVoiceCuePlayer(audioContext, options.cuePolicy);
    } catch {
      cuePlayer = createVoiceCuePlayer(null);
    }
  };

  /**
   * Reconciles the waiting tone with the current state.
   *
   * Called from every transition that can change the answer rather than having
   * each one start or stop the loop itself: scattered start/stop calls are how
   * a tone gets left running after the state it described has passed.
   */
  const syncThinkingCue = () => {
    const waiting = shouldPlayThinkingCue({
      awaitingUserAnswer,
      assistantAudible: assistantAudible(),
      userSpeaking,
      // A tool call in flight, or a reply queued behind one: the assistant
      // owns the floor even though nothing is coming out of the speaker.
      assistantWorking: toolCallsInFlight > 0 || pendingReplyRequested,
    });
    // Reported even when there is no cue player — the visual signal must not
    // depend on whether audio could be initialised.
    if (waiting !== lastWorkingReported) {
      lastWorkingReported = waiting;
      callbacks.onWorkingChange?.(waiting);
    }
    if (waiting) {
      if (workingWatchdog === null) {
        workingWatchdog = setTimeout(giveUpStuckWait, WORKING_TONE_LIMIT_MS);
      }
    } else if (workingWatchdog !== null) {
      clearTimeout(workingWatchdog);
      workingWatchdog = null;
    }
    if (cuePlayer === null) return;
    if (waiting) {
      cuePlayer.startThinking();
    } else {
      cuePlayer.stopThinking();
    }
  };

  /**
   * Gives the floor back after a wait that never ended.
   *
   * Every flag here is one that only something else was ever going to clear, so
   * clearing them is the whole point: whatever was awaited is not coming, and
   * the session's job now is to be usable again rather than accurate about a
   * turn nobody can finish. The microphone is reopened too — on half duplex it
   * may have been closed for a reply that never arrived, which is the version of
   * this that leaves someone talking to a session that cannot hear them.
   */
  const abandonStuckWait = () => {
    workingWatchdog = null;
    awaitingUserAnswer = false;
    pendingReplyRequested = false;
    responseRequested = false;
    responseActive = false;
    toolCallsInFlight = 0;
    syncThinkingCue();
    if (configured && !stopped) setMicrophoneEnabled(true);
    if (state !== "error" && !audioPlaying) setState("listening");
  };

  /**
   * The watchdog's version of giving up: the wait is abandoned *and said so*.
   *
   * From the user's ear "pulse, then silence" is identical to "the answer is
   * about to play"; the knock is what makes the silence after it mean "the
   * floor is yours" rather than "keep waiting". Only the timeout plays it —
   * the other abandonment (a suspended microphone) is announced as `deaf` by
   * its own path, and two knocks back to back would say two things went wrong.
   */
  const giveUpStuckWait = () => {
    playCue("dropped");
    abandonStuckWait();
  };

  const playCue = (cue: VoiceCue) => {
    ensureCuePlayer();
    if (cuePlayer === null) return;
    if (!mayPlayCue({ cue, userSpeaking, assistantAudible: assistantAudible() })) return;
    cuePlayer.play(cue);
  };

  /** Last time the remote track was actually audible; 0 until it ever is. */
  let lastAssistantAudioAt = 0;

  const assistantAudible = () =>
    isAssistantAudible({
      bufferPlaying: audioPlaying,
      lastAudibleAt: lastAssistantAudioAt,
      nowMs: Date.now(),
    });

  /**
   * Whether the model is mid-thought and must not be spoken over.
   *
   * Tool calls count. Between the response that *made* a tool call finishing
   * and the reply that follows it, no response is active and none is requested
   * — so a world event arriving in that window used to fire a `response.create`
   * straight into the middle of the agent's work. Two responses then raced: the
   * announcement and the reply to the tool output, which is how the same answer
   * came out twice and why an internal event read as an interruption rather
   * than something waiting its turn.
   */
  const isBusy = () => responseActive || responseRequested || toolCallsInFlight > 0;

  const sendResponseRequest = (instructions?: string) => {
    responseRequested = true;
    send(buildResponseCreateFrame(instructions));
  };

  /** Ask the model to answer what is already in the conversation. */
  const requestReply = () => {
    if (isBusy()) {
      // Several tool results in one turn collapse into a single reply.
      pendingReplyRequested = true;
      return;
    }
    // Instructed, not bare. Left to itself this response opened with the same
    // acknowledgement the model had just said before the tool call — audible
    // twice, even though the transcript deduplicated the second copy.
    sendResponseRequest(buildToolReplyInstructions());
  };

  /**
   * Ask the model to volunteer something the user did not ask about.
   *
   * Queued while the user is mid-utterance, not just while the model is busy.
   * `isBusy()` only knows about responses, so a thread finishing while someone
   * was halfway through a sentence started the announcement immediately and
   * talked straight over them. News can always wait; a sentence cannot be
   * un-interrupted.
   */
  const requestAnnouncement = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const key = trimmed.replace(/\s+/g, " ").toLocaleLowerCase();
    if (pendingAnnouncementKeys.has(key)) return;
    pendingAnnouncementKeys.add(key);
    if (pendingAnnouncements.length < MAX_ANNOUNCEMENTS_PER_BATCH) {
      pendingAnnouncements.push(trimmed);
    } else {
      omittedAnnouncementCount += 1;
    }
    if (isBusy() || userSpeaking || awaitingContinuation) return;

    // Every event used to become its own spoken response the instant it
    // arrived, so a handful of transitions landing together — a thread
    // finishing, another wanting approval — came out as several separate
    // utterances, each one a fresh interruption. They are gathered for a beat
    // first and said as one instead. A pathological burst is summarized rather
    // than copied wholesale into the model context; the wait is short enough
    // to be invisible for a single event, which is the common case.
    if (announcementBatchTimer !== null) return;
    announcementBatchTimer = setTimeout(() => {
      announcementBatchTimer = null;
      if (pendingAnnouncements.length === 0) return;
      // Conditions can change during the wait — the user may have started
      // talking — so this re-checks rather than assuming what it saw before.
      if (isBusy() || userSpeaking || awaitingContinuation) return;
      const batched = drainAnnouncements();
      sendResponseRequest(buildAnnouncementInstructions(batched));
    }, ANNOUNCEMENT_BATCH_MS);
  };

  const drainAnnouncements = (): string => {
    const lines = [...pendingAnnouncements];
    if (omittedAnnouncementCount > 0) {
      lines.push(
        `${omittedAnnouncementCount} additional update${omittedAnnouncementCount === 1 ? "" : "s"} arrived; mention the backlog briefly without listing it.`,
      );
    }
    pendingAnnouncements.length = 0;
    pendingAnnouncementKeys.clear();
    omittedAnnouncementCount = 0;
    return lines.join(" ");
  };

  const clearAnnouncements = () => {
    pendingAnnouncements.length = 0;
    pendingAnnouncementKeys.clear();
    omittedAnnouncementCount = 0;
  };

  const flushPendingResponse = () => {
    // Answering the user outranks volunteering news. Anything still queued
    // rides the next completion rather than being dropped, so simultaneous
    // events are merged into one utterance instead of talking over each other.
    if (pendingReplyRequested) {
      pendingReplyRequested = false;
      sendResponseRequest(buildToolReplyInstructions());
      return;
    }
    if (pendingAnnouncements.length > 0) {
      const text = drainAnnouncements();
      sendResponseRequest(buildAnnouncementInstructions(text));
    }
  };

  /**
   * Forces the drain when the events that should have ended playback did not.
   *
   * Only ever a last resort: it stops whatever is still scheduled and takes
   * the session back to listening. Being a second early is a worse outcome
   * than being a second late, which is why the deadlines that arm it are
   * padded rather than tight.
   */
  const abandonStuckPlayback = () => {
    playbackWatchdog = null;
    if (!audioPlaying) return;
    stopPlayback();
    audioGenerationDone = true;
    onPlaybackDrained();
  };

  const clearPlaybackWatchdog = () => {
    if (playbackWatchdog === null) return;
    clearTimeout(playbackWatchdog);
    playbackWatchdog = null;
  };

  /**
   * Arms the drain deadline for the audio currently scheduled.
   *
   * Re-armed from scratch on every chunk, so a reply that keeps arriving keeps
   * pushing the deadline out and only a queue that stops draining reaches it.
   */
  const armPlaybackWatchdog = (limitMs: number) => {
    clearPlaybackWatchdog();
    if (!audioPlaying) return;
    playbackWatchdog = setTimeout(abandonStuckPlayback, Math.max(limitMs, 0));
  };

  /** Wall-clock milliseconds of audio still scheduled on the PCM queue. */
  const queuedPlaybackMs = () => {
    if (audioContext === null) return 0;
    return Math.max(0, (nextPlayTime - audioContext.currentTime) * 1_000);
  };

  /** One transition for WebRTC buffer events and Grok's local PCM queue. */
  onPlaybackDrained = () => {
    clearPlaybackWatchdog();
    if (!audioPlaying) return;
    audioPlaying = false;
    // The "let me check that…" pause begins exactly here. Nothing else
    // re-evaluates the tone on the way out of audible speech.
    syncThinkingCue();
    if (isHalfDuplex() && configured) setMicrophoneEnabled(true);
    if (endWhenReplyFinishes && !responseActive) {
      endWhenReplyFinishes = false;
      callbacks.onEndedByVoice?.();
      stop();
      return;
    }
    if (state !== "error") setState("listening");
    if (flushWhenAudioDrains) {
      flushWhenAudioDrains = false;
      flushPendingResponse();
    }
  };

  const clearContinuationHold = () => {
    if (continuationTimer !== null) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
    awaitingContinuation = false;
  };

  /**
   * Decides whether the just-transcribed utterance was actually finished.
   *
   * The server has already created a response by the time the transcript
   * arrives — `create_response` fires off the VAD, which cannot read. So an
   * unfinished-sounding turn is handled by cancelling that response and waiting;
   * if the user carries on, their continuation is answered as one turn, and if
   * they do not, the grace expires and the reply is requested anyway so the
   * conversation cannot hang.
   *
   * Cancel-only: nothing of the user's is playing, and clearing the output
   * buffer would cut off anything that is.
   */
  const clearUtteranceFlush = () => {
    if (utteranceFlushTimer === null) return;
    clearTimeout(utteranceFlushTimer);
    utteranceFlushTimer = null;
  };

  const commitUserUtterance = (pending: BufferedUtterance) => {
    if (isLikelyHallucinatedTranscript(pending.text, options.language)) return;
    // Silent reasoning and tool work are not echo. Filtering throughout the
    // whole response lifecycle dropped legitimate short commands such as
    // "open settings" while the assistant was making no sound at all.
    if (isLikelyEchoFragment(pending.text, assistantAudible())) return;
    if (
      !shouldCommitUtterance({
        pending,
        lastCommitted: lastCommittedUserUtterance,
        nowMs: Date.now(),
      })
    ) {
      return;
    }
    lastCommittedUserUtterance = { ...pending, atMs: Date.now() };
    noteActivity();
    callbacks.onTranscript?.({ role: "user", text: pending.text });
    handleUtteranceEnd(pending.text);
  };

  const scheduleUserUtteranceFlush = () => {
    clearUtteranceFlush();
    utteranceFlushTimer = setTimeout(
      () => {
        utteranceFlushTimer = null;
        const pending = pendingUserUtterance;
        if (pending === null || userSpeaking) return;
        pendingUserUtterance = null;
        commitUserUtterance(pending);
      },
      voiceProvider === "xai" ? GROK_UTTERANCE_SETTLE_MS : UTTERANCE_SETTLE_MS,
    );
  };

  const noteUserTranscript = (text: string, itemId?: string) => {
    const pending = itemId === undefined ? { text } : { text, itemId };
    // OpenAI emits one completed event per turn. Grok Voice emits several —
    // partials, then the same finished line again — so only that backend
    // waits for the utterance to settle.
    if (voiceProvider !== "xai") {
      commitUserUtterance(pending);
      return;
    }
    pendingUserUtterance = pending;
    if (userSpeaking) {
      clearUtteranceFlush();
      return;
    }
    scheduleUserUtteranceFlush();
  };

  /**
   * Closes the user's floor after one committed transcript.
   *
   * Kept as one transition because the sound and waiting state describe the
   * same fact: the utterance landed and an answer is now owed. In particular,
   * a continuation timeout must not request a reply without making this
   * transition, or the longest intentional pause is also the least legible.
   */
  const acceptCommittedUserTurn = () => {
    if (awaitingUserAnswer) return;
    playCue("accepted");
    awaitingUserAnswer = true;
    syncThinkingCue();
  };

  const handleUtteranceEnd = (text: string) => {
    const decision = decideEndOfSpeech({ text, waitedAlready: heldForContinuation });
    if (decision.kind === "discard") {
      // A noise opened the turn and the server already started answering it.
      // Cancel that and say nothing: the correct reply to a door closing is
      // silence, not "I didn't catch that".
      heldForContinuation = false;
      clearContinuationHold();
      awaitingUserAnswer = false;
      syncThinkingCue();
      // Discard, not protect: this response is the answer to a noise, so its
      // audio is exactly what must not be heard.
      stopXaiPlayback();
      for (const frame of buildDiscardResponseFrames()) send(frame);
      responseRequested = false;
      callbacks.onNoiseIgnored?.();
      return;
    }
    if (decision.kind === "answer") {
      heldForContinuation = false;
      clearContinuationHold();
      // The turn is closed and accepted: this is the "heard you" moment. The
      // thinking loop runs from here until the answer is audible, so a long
      // tool call sounds like work rather than a dead session.
      acceptCommittedUserTurn();
      // Server VAD is supposed to create the reply. Grok often transcribes
      // without ever sending speech_started/stopped, so nobody is answering
      // unless we ask.
      if (!speechStoppedThisUtterance && !isBusy()) requestReply();
      return;
    }
    // Held for a continuation — deliberately silent. A beep here would be the
    // session announcing it is waiting, over someone still mid-thought.
    awaitingUserAnswer = false;
    syncThinkingCue();
    heldForContinuation = true;
    awaitingContinuation = true;
    // Same: the reply being held back is the one whose audio has to stop. Left
    // to play, its opening words came out, and the reply that eventually
    // answered the finished sentence opened with the same ones.
    stopXaiPlayback();
    for (const frame of buildDiscardResponseFrames()) send(frame);
    responseRequested = false;
    if (continuationTimer !== null) clearTimeout(continuationTimer);
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      awaitingContinuation = false;
      // They trailed off and left it there. Answer what was said rather than
      // leaving an open microphone and no reply. `requestReply` owns the busy
      // case: it queues behind real work instead of silently abandoning the
      // answer this acknowledgement promises.
      if (userSpeaking) return;
      acceptCommittedUserTurn();
      requestReply();
    }, decision.graceMs);
  };

  /**
   * Marks the moment as not-silent.
   *
   * Deliberately a timestamp checked on a poll, not a timer restarted by
   * events. Events are too sparse to measure silence with: a long utterance
   * produces `speech_started` and then nothing until it ends, so a countdown
   * armed on events alone expired *while the user was still talking* and closed
   * the session mid-sentence. The microphone level, sampled by the meter every
   * frame, is the only continuous signal for "someone is talking right now".
   */
  const noteActivity = () => {
    lastActivityAt = Date.now();
  };

  const startIdleWatch = () => {
    const seconds = options.silenceTimeoutSeconds ?? 0;
    if (seconds <= 0 || idleTimer !== null) return;
    noteActivity();
    idleTimer = setInterval(() => {
      // Never cut anyone off: the user speaking, or the orchestrator mid-reply,
      // both count as activity and hold the session open.
      if (responseActive || state === "speaking" || userSpeaking) {
        noteActivity();
        return;
      }
      if (Date.now() - lastActivityAt < seconds * 1_000) return;
      // A hidden page cannot produce the evidence this decision needs. Room
      // tone is measured on `requestAnimationFrame`, which stops when the phone
      // locks, and a locked phone's microphone is frequently muted by the
      // platform as well — so from here a live conversation and an abandoned
      // one look identical, and the watchdog was resolving that tie by ending
      // the session. Locking a phone mid-conversation is deliberate use, not
      // abandonment; it is the walk-with-headphones case this feature exists
      // for. The decision is deferred rather than cancelled: `lastActivityAt`
      // is left alone, so a session that really was idle ends as soon as the
      // page comes back rather than never.
      if (typeof document !== "undefined" && document.hidden) return;
      callbacks.onIdleTimeout?.();
      stop();
    }, IDLE_POLL_INTERVAL_MS);
  };

  /**
   * Opens the microphone once the session is known to be configured.
   *
   * Tracks are added to the peer connection before the data channel exists —
   * WebRTC needs them in the offer — so media starts flowing while the session
   * is still running on API defaults: no language pin, no instructions, and
   * server-side `create_response`. A word spoken into that window was
   * transcribed with no language hint and answered under default instructions,
   * which is how "hi" came back as Japanese: short audio is exactly what makes
   * a transcriber hallucinate, and nothing had told the model to speak English
   * yet. Muting until `session.updated` closes the window.
   *
   * Idempotent, and reached either by that event or by the fallback timer — a
   * server that renamed the ack must not leave the microphone dead forever.
   */
  /**
   * Opens or closes the microphone track mid-session.
   *
   * A disabled track transmits silence, so nothing reaches OpenAI at all — this
   * is the only thing that reliably stops the assistant's own voice being
   * transcribed as the user. Browser echo cancellation is requested and still
   * loses on a phone speaker, and every client-side heuristic can only judge the
   * echo *after* it has already been uploaded and acted on by the server's turn
   * detection. Not sending it is the fix; the heuristics are the fallback for
   * when the microphone has to stay open.
   */
  const setMicrophoneEnabled = (enabled: boolean) => {
    sendMicrophoneAudio = enabled;
    // Grok's PCM path must keep the capture track live. Muting it after
    // `MediaStreamAudioSourceNode` is connected leaves Chromium sending
    // silence while the orb still says "listening".
    if (voiceProvider === "xai") return;
    // Both streams: silence propagates through the gate, so muting the capture
    // alone happened to work — but the track actually being sent stayed
    // `enabled: true`, which is a different thing to anything reading track
    // state, and would break the moment the graph changed.
    for (const track of micStream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
    if (sentStream !== null && sentStream !== micStream) {
      for (const track of sentStream.getAudioTracks()) {
        track.enabled = enabled;
      }
    }
  };

  /** Pending `mute` report; see {@link watchMicrophoneAvailability}. */
  let micSuspendTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Reports the platform taking the microphone away, and handing it back.
   *
   * A phone locking, an incoming call, or another app claiming audio mutes the
   * capture track from underneath the page. Nothing is torn down — the peer
   * connection stays up and the assistant's audio keeps playing — so from the
   * inside the session looks healthy while the server hears pure silence. The
   * user goes on talking and gets no answer, which is the whole of the "it
   * stops responding after the first turn" report; because output still works,
   * they hear the waiting tone pulse over it.
   *
   * `deaf` and `mic-open` are by design the same cues a transport drop and a
   * reconnect play: the user's correct response — stop talking, then talk
   * again — is identical, so which subsystem failed is not worth a second
   * vocabulary.
   *
   * Debounced, because a brief mute is normal during device changes and route
   * switches; only a sustained one is worth telling anyone about.
   */
  const watchMicrophoneAvailability = (stream: MediaStream) => {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("mute", () => {
        if (stopped || micSuspendTimer !== null) return;
        micSuspendTimer = setTimeout(() => {
          micSuspendTimer = null;
          if (stopped || !track.muted) return;
          // The wait can never end while nothing can reach the server.
          abandonStuckWait();
          playCue("deaf");
        }, MIC_SUSPEND_REPORT_MS);
      });
      track.addEventListener("unmute", () => {
        if (micSuspendTimer !== null) {
          clearTimeout(micSuspendTimer);
          micSuspendTimer = null;
          return;
        }
        reportMicrophoneOpen();
      });
    }
  };

  /**
   * Whether to close the microphone while the assistant talks.
   *
   * Only when the user has already said they do not want to interrupt by voice:
   * half-duplex costs barge-in, which is exactly what that setting gives up, so
   * it takes nothing extra away. With interruption on, the microphone stays open
   * and the level and transcript filters do what they can.
   */
  const isHalfDuplex = () => options.interruptWhileSpeaking === false;

  const openMicrophone = () => {
    if (configured || stopped) return;
    configured = true;
    if (configureTimer !== null) {
      clearTimeout(configureTimer);
      configureTimer = null;
    }
    // Through `setMicrophoneEnabled`, not the raw stream: with voice isolation
    // on, the track handed to the peer connection is the gate's output, not
    // `micStream`, and it is the one that was muted at `addTrack`. Enabling
    // only the capture side left the session sending a permanently disabled
    // track — an open microphone locally and total silence at the server.
    setMicrophoneEnabled(true);
    // The one moment "you may start talking" is actually true: before this the
    // track is muted and anything said is discarded. Played here, inside the
    // transition, so the cue can never drift from the state it reports — after
    // a reconnect this is the same sound, because "the socket came back" was
    // never the news; "you can talk now" is.
    playCue("mic-open");
    if (state !== "error") setState("listening");
    startIdleWatch();
    startFloorWatch();
  };

  /**
   * The platform gave a suspended microphone back mid-session.
   *
   * A mute that spanned a half-duplex reply can leave the sent track disabled
   * with nothing left to turn it back on, so it is re-enabled explicitly. The
   * same `mic-open` cue as configuration, and through the same discipline: the
   * sound belongs to the transition that opens the microphone, not to whichever
   * event handler noticed it.
   */
  const reportMicrophoneOpen = () => {
    if (stopped || !configured) return;
    setMicrophoneEnabled(true);
    playCue("mic-open");
  };

  /**
   * Keeps the microphone's reopening off the animation frame.
   *
   * The level meter is the primary path and stays that way — it is the only one
   * that can react inside a syllable. But it runs on `requestAnimationFrame`,
   * which a locked phone stops entirely, and "the microphone reopens" is not a
   * thing that may depend on the screen being on. A slow interval cannot judge
   * echo, and does not try to: it only asks the question the meter would have
   * asked, using state the data channel keeps up to date regardless.
   */
  const startFloorWatch = () => {
    if (floorTimer !== null || !isHalfDuplex()) return;
    floorTimer = setInterval(reconcileMicrophoneFloor, FLOOR_RECONCILE_INTERVAL_MS);
  };

  const closeBargeInWindow = () => {
    if (bargeInTimer !== null) {
      clearTimeout(bargeInTimer);
      bargeInTimer = null;
    }
    bargeInWindow = null;
  };

  /**
   * Called when the server reports input speech while the assistant is talking.
   *
   * The server has been told not to interrupt on its own, so nothing has been
   * cancelled yet. Watch the microphone for a moment: if the sound sustains it
   * is someone talking and the response is cut; if it decays — a cup, a
   * keyboard, a door — the orchestrator simply keeps speaking, which is what it
   * should have been doing all along.
   */
  const considerBargeIn = () => {
    // Opted out: the orchestrator finishes its sentence no matter what the room
    // does. On a phone speaker its own voice returns through the microphone,
    // and no amount of level analysis is completely reliable against that.
    if (options.interruptWhileSpeaking === false) return;
    if (!responseActive || bargeInTimer !== null) return;
    const window = createBargeInWindow();
    bargeInWindow = window;
    bargeInTimer = setTimeout(() => {
      bargeInTimer = null;
      bargeInWindow = null;
      if (!responseActive) return;
      if (!window.verdict()) {
        callbacks.onNoiseIgnored?.();
        return;
      }
      stopXaiPlayback();
      for (const frame of buildInterruptFrames()) send(frame);
      // The gate has to reopen here: a cancelled response still emits
      // `response.done`, but clearing eagerly keeps a cancel that races with
      // completion from stranding the session mute.
      responseRequested = false;
    }, BARGE_IN_SUSTAIN_MS);
  };

  const startMetering = () => {
    if (callbacks.onLevels === undefined || meterFrame !== null) return;
    // Buffers are (re)allocated inside the tick: the assistant analyser does
    // not exist until the remote track arrives, so a buffer sized up front
    // would stay zero-length and read NaN forever.
    let micBuffer = new Uint8Array(0);
    let assistantBuffer = new Uint8Array(0);
    const tick = () => {
      if (micAnalyser !== null && micBuffer.length !== micAnalyser.fftSize) {
        micBuffer = new Uint8Array(micAnalyser.fftSize);
      }
      if (assistantAnalyser !== null && assistantBuffer.length !== assistantAnalyser.fftSize) {
        assistantBuffer = new Uint8Array(assistantAnalyser.fftSize);
      }
      const micLevel = micAnalyser !== null ? readLevel(micAnalyser, micBuffer) : 0;
      const assistantLevel =
        assistantAnalyser !== null ? readLevel(assistantAnalyser, assistantBuffer) : 0;
      // The same levels the orb is drawn from double as the barge-in evidence,
      // so judging an interruption costs no extra analysis. Both are needed:
      // the microphone alone cannot tell a person from the assistant's own
      // voice arriving back through the speaker.
      bargeInWindow?.push({ mic: micLevel, assistant: assistantLevel });
      // Well below the barge-in threshold: this only has to distinguish "a room
      // with someone in it, talking" from actual silence. Deliberately still the
      // raw microphone level — holding the session open while the assistant is
      // audible is correct, and `startIdleWatch` already treats speaking as
      // activity in its own right.
      if (micLevel >= IDLE_ACTIVE_LEVEL) noteActivity();
      // Measured backstop for the echo protections. `speaking-started` is the
      // primary signal and this changes nothing when it arrives; where it never
      // does, this is what still closes the microphone before the assistant's
      // voice can be heard by it.
      if (assistantLevel >= ASSISTANT_AUDIBLE_LEVEL) {
        lastAssistantAudioAt = Date.now();
        if (isHalfDuplex() && configured) setMicrophoneEnabled(false);
      } else {
        // Quiet again, and the grace window has passed: hand the turn back.
        reconcileMicrophoneFloor();
      }
      callbacks.onLevels?.({ mic: micLevel, assistant: assistantLevel });
      meterFrame = requestAnimationFrame(tick);
    };
    meterFrame = requestAnimationFrame(tick);
  };

  const attachMicMeter = (stream: MediaStream) => {
    if (callbacks.onLevels === undefined) return;
    try {
      audioContext ??= new AudioContext();
      void audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      micAnalyser = analyser;
      startMetering();
    } catch {
      // Metering is presentation only; a session without it still works.
    }
  };

  const attachAssistantMeter = (stream: MediaStream) => {
    if (callbacks.onLevels === undefined) return;
    try {
      audioContext ??= new AudioContext();
      void audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      // Analysis only — playback stays on the detached <audio> element, so
      // this node is deliberately NOT connected to the destination.
      audioContext.createMediaStreamSource(stream).connect(analyser);
      assistantAnalyser = analyser;
      startMetering();
    } catch {
      // Metering is presentation only; a session without it still works.
    }
  };

  const fetchToken = async (): Promise<RealtimeTokenResponse> => {
    const response = await fetch(joinUrl(options.httpBaseUrl, ORCHESTRATOR_REALTIME_TOKEN_PATH), {
      method: "POST",
      ...(options.bearerToken === null
        ? { credentials: "include" as const }
        : { headers: { authorization: `Bearer ${options.bearerToken}` } }),
    });

    if (!response.ok) {
      // The server sends a plain-text reason for the cases the user can act on
      // — 409 disabled or unconfigured, 402 out of credits — and says nothing
      // revealing for the rest. Show what it sent rather than replacing every
      // failure with one sentence that fits none of them.
      const detail = (await response.text().catch(() => "")).trim();
      const actionable = response.status === 409 || response.status === 402;
      throw new Error(
        actionable && detail.length > 0 ? detail : "Could not start a voice session.",
      );
    }

    return (await response.json()) as RealtimeTokenResponse;
  };

  const handleToolCall = async (callId: string, name: string, argumentsJson: string) => {
    if (handledToolCallIds.has(callId)) return;
    handledToolCallIds.add(callId);
    if (handledToolCallIds.size > MAX_HANDLED_TOOL_CALL_IDS) {
      const oldest = handledToolCallIds.values().next().value;
      if (oldest !== undefined) handledToolCallIds.delete(oldest);
    }
    toolCallsInFlight += 1;
    syncThinkingCue();
    try {
      // Bounded, because a tool call in flight now holds back announcements and
      // keeps the waiting tone running. Without a ceiling one hung request —
      // an unreachable environment, a request that never settles — would wedge
      // the whole session silently, with the tone pulsing over it forever.
      const result = await Promise.race([
        callbacks.onToolCall({ name, args: parseToolArguments(argumentsJson) }),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("That took too long.")), TOOL_CALL_TIMEOUT_MS);
        }),
      ]);
      send(buildToolOutputFrame({ callId, output: result }));
    } catch (cause) {
      // Report the failure back into the conversation so the model can tell the
      // user, rather than silently leaving the call unanswered and hanging.
      send(
        buildToolOutputFrame({
          callId,
          output: { error: cause instanceof Error ? cause.message : "tool failed" },
        }),
      );
    }
    toolCallsInFlight = Math.max(0, toolCallsInFlight - 1);
    // One reply per batch of tool calls, not one per call.
    requestReply();
    // After `requestReply`, so the queued-reply case keeps the tone running
    // rather than dropping it for the gap before the answer starts.
    syncThinkingCue();
  };

  const handleMessage = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const event = parseRealtimeEvent(parsed, voiceProvider);
    switch (event.kind) {
      case "user-transcript":
        // Grok Voice emits several completed transcripts for one spoken turn.
        // Buffer here and commit once the utterance settles, or one "hello"
        // becomes four user messages and four model replies.
        noteUserTranscript(event.text, event.itemId);
        return;
      case "assistant-transcript":
        callbacks.onTranscript?.({ role: "assistant", text: event.text });
        return;
      case "tool-call":
        void handleToolCall(event.callId, event.name, event.argumentsJson);
        return;
      case "session-configured":
        // The language pin and instructions are live; the microphone can open.
        // The `mic-open` cue plays inside `openMicrophone` itself.
        openMicrophone();
        return;
      case "user-transcript-delta":
        // The first words of this utterance came back as text: the system can
        // demonstrably hear them. Once only — a click per word would be a
        // typewriter — and reset when the next utterance begins. Never after
        // the VAD has closed the floor, where it would read as "you cannot
        // talk anymore". Providers whose event ordering makes that guard a
        // coin flip get no click at all — see HEARD_CUE_BY_PROVIDER.
        if (
          HEARD_CUE_BY_PROVIDER[voiceProvider] === "first-delta" &&
          !heardCuePlayedThisUtterance &&
          !speechStoppedThisUtterance
        ) {
          heardCuePlayedThisUtterance = true;
          playCue("heard");
        }
        noteActivity();
        // Keep the latest cumulative text so a missing `completed` still
        // commits what they said when the VAD closes the turn.
        if (event.text.length > 0) {
          pendingUserUtterance =
            event.itemId === undefined
              ? { text: event.text }
              : { text: event.text, itemId: event.itemId };
          // Grok's documented order is speech_stopped, then the first
          // `.updated` delta. Flushing only on VAD stop left pending empty,
          // and a missing `.completed` then never registered the utterance —
          // the orb stayed on "listening". Commit once they have paused.
          if (voiceProvider === "xai") {
            if (userSpeaking) clearUtteranceFlush();
            else scheduleUserUtteranceFlush();
          }
        }
        return;
      case "user-speech-started":
        userSpeaking = true;
        speechStoppedThisUtterance = false;
        heardCuePlayedThisUtterance = false;
        clearUtteranceFlush();
        noteActivity();
        // They have the floor again; nothing should be sounding under them.
        awaitingUserAnswer = false;
        syncThinkingCue();
        // They carried on: this is the rest of the thought, so stop waiting and
        // let the combined turn be answered when it genuinely ends.
        clearContinuationHold();
        considerBargeIn();
        return;
      case "user-speech-stopped":
        userSpeaking = false;
        speechStoppedThisUtterance = true;
        noteActivity();
        if (pendingUserUtterance !== null) scheduleUserUtteranceFlush();
        // Anything queued while they were talking goes out now that they have
        // stopped — but only if nothing else is in flight, and never while a
        // reply is being held for a continuation. Without this an announcement
        // that arrived mid-sentence could sit in the queue indefinitely when the
        // turn produced no response of its own to ride out on.
        if (!isBusy() && !awaitingContinuation && pendingAnnouncements.length > 0) {
          flushPendingResponse();
        }
        // Otherwise only an end marker; the barge-in verdict is timed off the
        // level window, and this fires a full silence-duration later.
        return;
      case "speaking-started":
        noteActivity();
        audioPlaying = true;
        // The answer is arriving, so the wait is over and the tone stops. Set
        // before syncing: the gate reads `assistantAudible()`, which this drives.
        awaitingUserAnswer = false;
        syncThinkingCue();
        // Close the microphone for the duration rather than trying to tell the
        // echo apart from the user afterwards.
        if (isHalfDuplex()) setMicrophoneEnabled(false);
        setState("speaking");
        return;
      case "assistant-audio-done":
        audioGenerationDone = true;
        if (playbackSources.length === 0) {
          onPlaybackDrained();
          return;
        }
        // Nothing more will be queued, so the deadline is now final.
        armPlaybackWatchdog(queuedPlaybackMs() + PLAYBACK_DRAIN_GRACE_MS);
        return;
      case "speaking-stopped":
        onPlaybackDrained();
        return;
      case "response-started":
        audioGenerationDone = false;
        // A response that begins while the previous one is still audible, and
        // that nothing here asked for, is the server answering something it
        // heard during playback — in practice the orchestrator's own voice
        // returning through a phone speaker. Both reported mobile symptoms come
        // from letting it run: it re-answers the question already being
        // answered, which reads as the assistant rewording the same point, and
        // its audio cuts over the tail of the sentence still playing.
        //
        // `interrupt_response: false` stops the server cancelling the first
        // response, but `create_response: true` still spawns this second one.
        // Cancelling it here is the only place that distinction can be made,
        // and it holds whatever the device is — unlike closing the microphone,
        // which depends on recognising the device as echo-prone first.
        if (assistantAudible() && !responseRequested && pendingAnnouncements.length === 0) {
          // Cancel only — the audio still playing belongs to the response being
          // protected, so clearing the output buffer would cut it off.
          for (const frame of buildCancelResponseFrames()) send(frame);
          callbacks.onNoiseIgnored?.();
          return;
        }
        responseRequested = false;
        responseActive = true;
        // Tool output sent *before* this response began is already visible to
        // it, so a reply queued by a second tool call in the same batch would
        // answer the same question twice. That is the repeated-answer bug: two
        // tools in one turn produced one reply here and an identical one from
        // the flush on completion. A tool call made *during* this response sets
        // the flag again afterwards, which is the case that must still queue.
        pendingReplyRequested = false;
        return;
      case "response-finished":
        if (event.usage !== undefined) callbacks.onUsage?.(event.usage);
        noteActivity();
        responseActive = false;
        responseRequested = false;
        // Nothing more is coming for this turn — including the case where it
        // produced no audio at all, which would otherwise leave the tone
        // pulsing over a finished conversation.
        awaitingUserAnswer = false;
        syncThinkingCue();
        closeBargeInWindow();
        // Nothing is playing, so the microphone may reopen immediately.
        if (isHalfDuplex() && configured && !audioPlaying) setMicrophoneEnabled(true);
        // `response.done` means the server finished generating, not that the
        // user finished hearing it: audio already handed to the output buffer
        // is still playing. Starting the next response here truncated the tail
        // of the current one, which is why a queued announcement arriving mid
        // answer cut the sentence in half. Wait for the buffer to drain.
        if (audioPlaying) {
          if (pendingReplyRequested || pendingAnnouncements.length > 0) {
            flushWhenAudioDrains = true;
          }
          // It does mean no *further* audio is coming for this response, which
          // is the only thing the PCM queue was waiting to be told. It used to
          // learn that solely from `response.output_audio.done`, so a response
          // that ended without one — cancelled, errored, or with a stray delta
          // after it that reset the flag — left a queue that drained to empty
          // and then sat there, mic shut, on "Speaking" for good.
          if (voiceProvider === "xai") {
            audioGenerationDone = true;
            if (playbackSources.length === 0) {
              onPlaybackDrained();
              return;
            }
            armPlaybackWatchdog(queuedPlaybackMs() + PLAYBACK_DRAIN_GRACE_MS);
          } else {
            // No queue to measure on the media-track transport; only a ceiling.
            armPlaybackWatchdog(TRACK_DRAIN_LIMIT_MS);
          }
          return;
        }
        // The user asked to be left alone and has now heard the reply that said
        // so. Closing before this point would have cut the goodbye in half.
        if (endWhenReplyFinishes) {
          endWhenReplyFinishes = false;
          callbacks.onEndedByVoice?.();
          stop();
          return;
        }
        if (state !== "error") setState("listening");
        flushPendingResponse();
        return;
      case "error":
        // A rejected request never produces `response.created`, so clear the
        // in-flight flag or the gate would close forever and the orchestrator
        // would go mute.
        responseRequested = false;
        // In-band error events are not session death: the API reports benign
        // conditions this way (a response.create colliding with an active
        // response, a rejected frame), and the audio/data channel stays live.
        // Latching "error" here would strand a working session in a state the
        // UI treats as terminal. Report it; let connection failures surface
        // through the negotiation path instead.
        if (isDataOpen()) {
          // A collision is the user talking over a reply that was already
          // being generated. It is not a fault and there is nothing for them
          // to dismiss — say "that did not land" in the only register that
          // works mid-conversation, and leave the error channel for faults.
          if (isResponseCollisionError(event.message)) {
            playCue("dropped");
            callbacks.onNoiseIgnored?.();
            return;
          }
          callbacks.onError?.(event.message);
        } else {
          fail(event.message);
        }
        return;
      case "assistant-audio-delta":
        // OpenAI delivers audio on the WebRTC track; Grok sends PCM on the socket.
        if (voiceProvider !== "xai") return;
        audioGenerationDone = false;
        playAudioDelta(event.audio);
        if (!audioPlaying) {
          noteActivity();
          audioPlaying = true;
          awaitingUserAnswer = false;
          syncThinkingCue();
          if (isHalfDuplex()) setMicrophoneEnabled(false);
          setState("speaking");
        }
        // Pushed out by every chunk that arrives, so only a queue that stops
        // draining ever reaches it.
        armPlaybackWatchdog(queuedPlaybackMs() + PLAYBACK_DRAIN_GRACE_MS);
        return;
      case "ignored":
        return;
    }
  };

  const connectXaiWebsocket = async (token: RealtimeTokenResponse) => {
    const url = token.realtimeUrl ?? buildXaiRealtimeWebsocketUrl(token.model);
    const ws = new WebSocket(url, [xaiClientSecretProtocol(token.value)]);
    socket = ws;
    startPcmCapture(sentStream ?? micStream ?? new MediaStream());

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        if (stopped) {
          ws.close();
          resolve();
          return;
        }
        established = true;
        send(
          buildSessionUpdate({
            authority: options.authority,
            confirmDestructiveActions: options.confirmDestructiveActions,
            language: options.language,
            model: token.model,
            provider: "xai",
            voice: token.voice,
            ...(options.recentHistory !== undefined
              ? { recentHistory: options.recentHistory }
              : {}),
          }) as unknown as Record<string, unknown>,
        );
        configureTimer = setTimeout(openMicrophone, SESSION_CONFIGURE_TIMEOUT_MS);
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to Grok Voice."));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    ws.addEventListener("message", (event: MessageEvent<string | Blob | ArrayBuffer>) => {
      if (typeof event.data !== "string") return;
      handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      if (stopped || !established) return;
      reportConnectionLost();
    });
  };

  const start = async () => {
    if (state !== "idle" && state !== "error") return;
    stopped = false;
    setState("connecting");

    try {
      const token = await fetchToken();
      if (stopped) return;
      voiceProvider = token.provider ?? (token.transport === "websocket" ? "xai" : "openai");
      callbacks.onSessionReady?.({ model: token.model, voice: token.voice });

      const connection = new RTCPeerConnection();
      peer = connection;
      // Registered per session and removed with it, so a stopped session cannot
      // be resurrected by the user unlocking their phone later.
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityChange);
      }

      // Remote audio: attach to a detached element so playback does not depend
      // on anything being mounted in the DOM.
      audioElement = new Audio();
      audioElement.autoplay = true;
      // A dropped connection is silent from the user's side: the microphone
      // stays open and they keep talking to something that cannot hear them.
      // Surfacing it is what makes an automatic reconnect possible at all.
      connection.onconnectionstatechange = () => {
        if (stopped) return;
        const peerState = connection.connectionState;
        if (peerState === undefined) return;

        if (peerState === "connected") {
          established = true;
          clearUnstableWatch();
          return;
        }

        // A connection that has never been up has not *dropped*. Reporting a
        // negotiation failure here is what broke starting a session outright:
        // this handler called stop(), which set the `stopped` latch, so the
        // in-flight await in start() threw and its catch read the latch as
        // "cancelled by the user" — swallowing the error. The session went
        // quietly back to idle with nothing shown. A setup failure belongs to
        // start()'s own error path, which reports it.
        if (!established) return;

        // Transient by specification: ICE reports `disconnected` whenever
        // connectivity checks lapse, and on a phone it usually comes back
        // within a second or two. Give it that chance before tearing anything
        // down — but keep watching, because sometimes it does not.
        if (isConnectionUnstableState(peerState)) {
          // Backgrounding commonly emits `disconnected` *after* the visibility
          // event. A timer created here would be throttled while hidden and can
          // fire immediately on unlock, before ICE has had a chance to recover.
          // The visibility handler starts a fresh, full grace window on return.
          if (typeof document !== "undefined" && document.hidden) {
            clearUnstableWatch();
            return;
          }
          if (unstableTimer !== null) return;
          unstableTimer = setTimeout(() => {
            unstableTimer = null;
            if (stopped || connection.connectionState === "connected") return;
            reportConnectionLost();
          }, DISCONNECTED_GRACE_MS);
          return;
        }

        clearUnstableWatch();
        if (!isConnectionLostState(peerState)) return;
        reportConnectionLost();
      };
      connection.ontrack = (event) => {
        if (stopped) return;
        const [stream] = event.streams;
        if (stream && audioElement) {
          audioElement.srcObject = stream;
          attachAssistantMeter(stream);
        }
      };

      const acquiredMicStream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(),
      });
      if (stopped) {
        // stop() already ran and found nothing to release for this stream —
        // the microphone was granted after the fact and must not stay hot.
        for (const track of acquiredMicStream.getTracks()) {
          track.stop();
        }
        releaseResources();
        return;
      }
      micStream = acquiredMicStream;
      watchMicrophoneAvailability(acquiredMicStream);

      // The gate sits between the microphone and the peer connection. It hands
      // back the raw stream on every failure path, so this cannot cost the user
      // their microphone — the worst case is unprocessed audio.
      ensureCuePlayer();
      const isolation = await applyVoiceIsolation({
        stream: acquiredMicStream,
        context: audioContext,
        enabled: options.voiceIsolation === true,
      });
      releaseIsolation = isolation.release;
      sentStream = isolation.stream;

      if (voiceProvider === "xai" || token.transport === "websocket") {
        connection.close();
        peer = null;
        if (audioElement) {
          audioElement.srcObject = null;
          audioElement = null;
        }
        // Leave the capture track enabled. Audio is withheld until
        // `session.updated` by `configured` / `sendMicrophoneAudio`, not by
        // muting the track — see `startPcmCapture`.
        attachMicMeter(acquiredMicStream);
        await connectXaiWebsocket(token);
        return;
      }

      for (const track of sentStream.getAudioTracks()) {
        // Muted until the session is configured; see openMicrophone.
        track.enabled = false;
        connection.addTrack(track, sentStream);
      }
      // Deliberately the *raw* stream: barge-in thresholds were tuned against
      // unprocessed levels, and metering the gated audio would move the noise
      // floor out from under them — the regression the plan for this feature
      // called the most likely one.
      attachMicMeter(acquiredMicStream);

      const dataChannel = connection.createDataChannel("oai-events");
      channel = dataChannel;
      dataChannel.addEventListener("open", () => {
        send(
          buildSessionUpdate({
            authority: options.authority,
            confirmDestructiveActions: options.confirmDestructiveActions,
            language: options.language,
            // Decides whether a `reasoning` block is legal for this model.
            model: token.model,
            provider: voiceProvider,
            voice: token.voice,
            ...(options.recentHistory !== undefined
              ? { recentHistory: options.recentHistory }
              : {}),
          }) as unknown as Record<string, unknown>,
        );
        // Stay muted, and stay out of "listening", until the server confirms it
        // took the configuration.
        configureTimer = setTimeout(openMicrophone, SESSION_CONFIGURE_TIMEOUT_MS);
      });
      dataChannel.addEventListener("message", (event: MessageEvent<string>) => {
        handleMessage(event.data);
      });

      const offer = await connection.createOffer();
      if (stopped) {
        releaseResources();
        return;
      }
      await connection.setLocalDescription(offer);

      const answer = await fetch(
        `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(token.model)}`,
        {
          method: "POST",
          body: offer.sdp ?? "",
          headers: {
            Authorization: `Bearer ${token.value}`,
            "Content-Type": "application/sdp",
          },
        },
      );
      if (stopped) {
        releaseResources();
        return;
      }

      if (!answer.ok) {
        // The body says what is actually wrong. Discarding it made a spent
        // account indistinguishable from a flaky network.
        const body = await answer.text().catch(() => "");
        throw new Error(describeNegotiationFailure(answer.status, body, voiceProvider));
      }

      await connection.setRemoteDescription({
        type: "answer",
        sdp: await answer.text(),
      });
      if (stopped) {
        releaseResources();
        return;
      }
    } catch (cause) {
      // An external stop() mid-start closes the peer under our feet and makes
      // the pending await throw; that is cancellation, not an error to report.
      const wasCancelled = stopped;
      stop();
      if (!wasCancelled) {
        fail(cause instanceof Error ? cause.message : "Could not start a voice session.");
      }
    }
  };

  const releaseResources = () => {
    closeBargeInWindow();
    clearUnstableWatch();
    established = false;
    if (idleTimer !== null) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (floorTimer !== null) {
      clearInterval(floorTimer);
      floorTimer = null;
    }
    if (configureTimer !== null) {
      clearTimeout(configureTimer);
      configureTimer = null;
    }
    configured = false;
    sendMicrophoneAudio = false;
    userSpeaking = false;
    responseActive = false;
    responseRequested = false;
    pendingReplyRequested = false;
    // The session is going away; nothing will come back to decrement it, and a
    // stale count would keep the waiting tone running into the next session.
    toolCallsInFlight = 0;
    if (announcementBatchTimer !== null) {
      clearTimeout(announcementBatchTimer);
      announcementBatchTimer = null;
    }
    clearAnnouncements();
    audioPlaying = false;
    flushWhenAudioDrains = false;
    clearPlaybackWatchdog();
    clearUtteranceFlush();
    pendingUserUtterance = null;
    lastCommittedUserUtterance = null;

    stopPlayback();
    if (captureProcessor !== null) {
      captureProcessor.disconnect();
      captureProcessor.onaudioprocess = null;
      captureProcessor = null;
    }
    captureResampler = null;
    captureSource?.disconnect();
    captureSource = null;
    playbackGain?.disconnect();
    playbackGain = null;

    if (socket !== null) {
      socket.close();
      socket = null;
    }

    channel?.close();
    channel = null;

    // Before the tracks: the gate's destination track is one of them, and
    // disposing the graph first keeps the ordering obvious rather than relying
    // on the loop below to have caught it.
    releaseIsolation?.();
    releaseIsolation = null;

    for (const track of micStream?.getTracks() ?? []) {
      track.stop();
    }
    // The gate's own output track is not part of `micStream`, so without this
    // it survives the session — one leaked track per session, held open.
    if (sentStream !== null && sentStream !== micStream) {
      for (const track of sentStream.getTracks()) {
        track.stop();
      }
    }
    micStream = null;
    sentStream = null;

    if (workingWatchdog !== null) {
      clearTimeout(workingWatchdog);
      workingWatchdog = null;
    }
    if (micSuspendTimer !== null) {
      clearTimeout(micSuspendTimer);
      micSuspendTimer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    peer?.close();
    peer = null;

    if (meterFrame !== null) {
      cancelAnimationFrame(meterFrame);
      meterFrame = null;
    }
    micAnalyser = null;
    assistantAnalyser = null;
    // Stops the thinking loop; the context itself is closed with the rest of
    // the audio graph below, so the player must not close it here.
    awaitingUserAnswer = false;
    cuePlayer?.stopThinking();
    cuePlayer = null;
    if (audioContext !== null) {
      void audioContext.close().catch(() => undefined);
      audioContext = null;
    }
    callbacks.onLevels?.({ mic: 0, assistant: 0 });

    if (audioElement) {
      audioElement.srcObject = null;
      audioElement = null;
    }
  };

  const stop = () => {
    stopped = true;
    releaseResources();
    setState("idle");
  };

  return {
    start,
    stop,
    endAfterReply: () => {
      if (state === "idle") return;
      // Nothing is being said, so there is no farewell to wait for.
      if (!responseActive && !responseRequested) {
        callbacks.onEndedByVoice?.();
        stop();
        return;
      }
      endWhenReplyFinishes = true;
    },
    hush: () => {
      if (!responseActive) return;
      stopPlayback();
      for (const frame of buildInterruptFrames()) send(frame);
      responseRequested = false;
      closeBargeInWindow();
      // Anything queued was going to be spoken next; being told to be quiet
      // means that too, not just the sentence in progress.
      clearAnnouncements();
      pendingReplyRequested = false;
      audioPlaying = false;
      flushWhenAudioDrains = false;
      clearPlaybackWatchdog();
      // Cancelling clears the output buffer, which may not emit a stop event.
      if (isHalfDuplex() && configured) setMicrophoneEnabled(true);
      if (state !== "error") setState("listening");
    },
    announce: (text: string) => {
      if (state !== "listening" && state !== "speaking") return;
      // Through the same gate as tool replies: announcing over an in-flight
      // response is the other way duplicate speech got queued up.
      requestAnnouncement(text);
    },
    get state() {
      return state;
    },
  };
}
