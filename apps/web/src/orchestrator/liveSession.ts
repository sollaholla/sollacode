import {
  ORCHESTRATOR_LIVE_SESSION_PATH,
  ORCHESTRATOR_LIVE_DELEGATION_PATH,
  OrchestratorLiveStartResult,
  OrchestratorLiveWorkEvent,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type {
  LiveSessionRoutes,
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSessionOptions,
  VoiceSessionState,
} from "./realtimeSession";
import { applyVoiceIsolation, microphoneConstraints } from "./voiceIsolation";
import {
  createLiveTranscriptContext,
  liveAppendChunks,
  parseLiveTranscript,
  trimLiveHistory,
} from "./liveProtocol";
import type { RecentConversationEntry } from "./realtimeProtocol";

const decodeStart = Schema.decodeUnknownSync(OrchestratorLiveStartResult);
const decodeWork = Schema.decodeUnknownSync(OrchestratorLiveWorkEvent);
const terminalWork = new Set(["completed", "failed", "cancelled", "expired"]);
const MAX_WIRE_EVENT_CHARS = 100_000;
/** Longest wait for trailing speech before re-asking a delegation that found nothing new. */
const TRAILING_TRANSCRIPT_MS = 1_500;

const ORCHESTRATOR_LIVE_ROUTES: LiveSessionRoutes = {
  sessionPath: ORCHESTRATOR_LIVE_SESSION_PATH,
  releasePath: `${ORCHESTRATOR_LIVE_SESSION_PATH}/release`,
  delegationPath: ORCHESTRATOR_LIVE_DELEGATION_PATH,
};

/** GPT-Live has its own full-duplex protocol. Realtime response/VAD commands
 * must never be sent on this channel. Backend task lifetime is independent.
 * The orchestrator's routes unless `options.live` names others (agent calls).
 * Leaving the page releases the host session at once (a keepalive request),
 * since the graceful close cannot finish during unload. */
export function createLiveVoiceSession(
  options: VoiceSessionOptions,
  callbacks: VoiceSessionCallbacks,
): VoiceSession {
  let state: VoiceSessionState = "idle";
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let mic: MediaStream | null = null;
  let sent: MediaStream | null = null;
  let audio: HTMLAudioElement | null = null;
  let audioContext: AudioContext | null = null;
  let releaseIsolation: (() => void) | null = null;
  let sessionId: string | null = null;
  let ready = false;
  let stopped = false;
  let closing = false;
  let finalized = false;
  let usageSeconds = 0;
  let eventSequence = 0;
  let latestDelegationId: string | null = null;
  let lastActivity = Date.now();
  let lastAudible = 0;
  let mutedOutput = false;
  let endAfterAudio = false;
  let muted = false;
  let meter: ReturnType<typeof setInterval> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let unstableTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let released = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let model = options.model ?? "gpt-live-1";
  let voice = "marin";
  const routes = options.live ?? ORCHESTRATOR_LIVE_ROUTES;
  const opening = new AbortController();
  const workStreams = new Set<AbortController>();
  const delegationTimers = new Set<ReturnType<typeof setTimeout>>();
  const handledEvents = new Set<string>();
  const handledDelegations = new Set<string>();
  /** User transcript fragments heard so far; a delegation notes the count it was sent with. */
  let userFragments = 0;
  /** Called when the user's transcript goes quiet (its caption flushes). */
  const userTranscriptSettled = new Set<() => void>();
  const context = createLiveTranscriptContext(options.recentHistory);
  const transcripts: Record<
    "user" | "assistant",
    { text: string; timer: ReturnType<typeof setTimeout> | null }
  > = {
    user: { text: "", timer: null },
    assistant: { text: "", timer: null },
  };
  const headers = {
    "content-type": "application/json",
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
  const url = (path: string) => `${options.httpBaseUrl.replace(/\/$/, "")}${path}`;
  const setState = (next: VoiceSessionState) => {
    if (state !== next) {
      state = next;
      callbacks.onStateChange?.(next);
    }
  };
  const flush = (role: "user" | "assistant") => {
    const pending = transcripts[role];
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const text = pending.text.trim();
    pending.text = "";
    if (text) callbacks.onTranscript?.({ role, text });
  };
  const reportUsage = () => {
    if (sessionId) callbacks.onLiveUsage?.({ sessionId, seconds: usageSeconds, finalized });
  };
  const releaseSession = () => {
    if (!sessionId || released) return;
    released = true;
    void fetch(url(routes.releasePath), {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => undefined);
  };
  // Reload, tab close or navigating away: `stop()` waits for GPT-Live's final
  // receipt, which never arrives during unload, so free the host's session now.
  const onPageHide = () => releaseSession();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    closing = true;
    ready = false;
    readyReject?.(new Error("Voice session ended before startup completed."));
    readyResolve = null;
    readyReject = null;
    opening.abort();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (meter) clearInterval(meter);
    if (closeTimer) clearTimeout(closeTimer);
    if (unstableTimer) clearTimeout(unstableTimer);
    for (const timer of delegationTimers) clearTimeout(timer);
    delegationTimers.clear();
    userTranscriptSettled.clear();
    for (const request of workStreams) request.abort();
    workStreams.clear();
    flush("user");
    flush("assistant");
    channel?.close();
    channel = null;
    peer?.close();
    peer = null;
    releaseIsolation?.();
    releaseIsolation = null;
    for (const track of sent?.getTracks() ?? []) track.stop();
    for (const track of mic?.getTracks() ?? []) track.stop();
    sent = null;
    mic = null;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio = null;
    }
    void audioContext?.close().catch(() => undefined);
    audioContext = null;
    reportUsage();
    releaseSession();
    callbacks.onWorkingChange?.(false);
    callbacks.onLevels?.({ mic: 0, assistant: 0 });
    setState("idle");
  };
  const send = (event: object) => {
    if (!ready || closing || stopped || channel?.readyState !== "open") return false;
    try {
      channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  };
  const append = (
    type: "session.commentary.append" | "session.thinking.append" | "session.instructions.append",
    text: string,
    delegationId: string | null,
  ) => {
    const chunks = liveAppendChunks(text);
    if (chunks.length === 0) return false;
    return chunks.every((content) =>
      send({
        type,
        event_id: `solla-live-${++eventSequence}`,
        delegation_id: delegationId,
        content,
      }),
    );
  };
  const close = () => {
    if (closing || stopped) return;
    if (!ready || channel?.readyState !== "open") {
      cleanup();
      return;
    }
    // Stop capture immediately; keep the transport until the final receipt.
    for (const track of mic?.getTracks() ?? []) track.enabled = false;
    for (const track of sent?.getTracks() ?? []) track.enabled = false;
    closing = true;
    try {
      channel.send(JSON.stringify({ type: "session.close" }));
    } catch {
      cleanup();
      return;
    }
    closeTimer = setTimeout(() => {
      callbacks.onError?.(
        "Voice ended without final usage confirmation. Delegated tasks remain in agent activity.",
      );
      cleanup();
    }, 5_000);
  };
  const lost = () => {
    if (stopped) return;
    const reconnect = ready && !closing;
    cleanup();
    if (reconnect) callbacks.onConnectionLost?.();
  };
  /** The host refused a leased session (409): it has nothing left to release. */
  const gone = () => {
    if (stopped) return;
    released = true;
    cleanup();
    callbacks.onSessionGone?.();
  };
  const startHeartbeat = () => {
    const heartbeat = routes.heartbeat;
    if (!heartbeat || !sessionId || heartbeatTimer) return;
    const id = sessionId;
    heartbeatTimer = setInterval(() => {
      if (stopped) return;
      void fetch(url(heartbeat.path), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ sessionId: id }),
      }).then(
        (response) => {
          if (response.status === 409) gone();
        },
        // A missed beat is fine: the lease outlasts a few of them.
        () => undefined,
      );
    }, heartbeat.everySeconds * 1_000);
  };
  /**
   * Asks again, once, for a delegation the host answered with nothing new:
   * the person's words can trail GPT-Live's delegation. Waits for the user
   * transcript to settle (at once if it already did since the request was
   * sent), at most {@link TRAILING_TRANSCRIPT_MS}.
   */
  const rerunAfterTranscript = (delegationId: string, sequence: number, heard: number) => {
    const settled = userFragments > heard && transcripts.user.timer === null;
    const run = () => {
      userTranscriptSettled.delete(run);
      clearTimeout(timer);
      delegationTimers.delete(timer);
      void runDelegation(delegationId, sequence, 0, true);
    };
    const timer = setTimeout(run, settled ? 0 : TRAILING_TRANSCRIPT_MS);
    delegationTimers.add(timer);
    if (!settled) userTranscriptSettled.add(run);
  };
  const runDelegation = async (
    delegationId: string,
    sequence: number,
    attempt = 0,
    rerun = false,
  ): Promise<void> => {
    if (closing || stopped || !sessionId || latestDelegationId !== delegationId) return;
    if (!context.hasUserSpeech()) {
      // The person's first words can trail the delegation too: wait for them
      // once before asking them to say it again.
      if (!rerun) {
        rerunAfterTranscript(delegationId, sequence, userFragments);
        return;
      }
      append(
        "session.commentary.append",
        "The transcript is not available yet. Ask the user to repeat the request before starting work.",
        delegationId,
      );
      return;
    }
    const abort = new AbortController();
    workStreams.add(abort);
    callbacks.onWorkingChange?.(true);
    let terminal = false;
    const heard = userFragments;
    try {
      const response = await fetch(url(routes.delegationPath), {
        method: "POST",
        headers,
        credentials: "include",
        signal: abort.signal,
        body: JSON.stringify({ sessionId, delegationId, sequence, context: context.context() }),
      });
      if (response.status === 409 && routes.heartbeat) {
        // The host ended this leased session (the call), or restarted.
        await response.body?.cancel();
        gone();
        return;
      }
      if (!response.ok)
        throw new Error(
          (await response.text()).slice(0, 500) || "The assistant could not accept the task.",
        );
      if (latestDelegationId !== delegationId || closing || stopped) {
        await response.body?.cancel();
        return;
      }
      // The backend keeps corrections with the active worker. Only its newest
      // Live delegation receives subsequent commentary; cancelling a reader
      // does not cancel the durable task.
      for (const previous of workStreams) if (previous !== abort) previous.abort();
      if (!response.body) throw new Error("No task update stream was returned.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let lastText = "";
      /** Whether any event carried text for GPT-Live. */
      let spoke = false;
      try {
        for (;;) {
          if (stopped || closing || latestDelegationId !== delegationId) break;
          const chunk = await reader.read();
          if (latestDelegationId !== delegationId || closing || stopped) break;
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          if (pending.length > MAX_WIRE_EVENT_CHARS)
            throw new Error("The assistant returned an oversized task update.");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = decodeWork(JSON.parse(line));
            terminal = terminalWork.has(event.status);
            callbacks.onWorkingChange?.(
              !terminal && event.status !== "waiting-input" && event.status !== "pending-approval",
            );
            if (lastText !== event.text) {
              const audible =
                terminal || event.status === "waiting-input" || event.status === "pending-approval";
              append(
                audible ? "session.commentary.append" : "session.thinking.append",
                event.text,
                delegationId,
              );
              lastText = event.text;
              if (event.text.trim()) spoke = true;
            }
          }
          if (chunk.done || terminal) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!terminal && !closing && !stopped && latestDelegationId === delegationId)
        throw new Error(
          "Task updates disconnected. The task may still be running; check agent activity.",
        );
      // A silent ending: nothing new reached the chat. Ask again once the
      // person's words arrive; a second one closes the delegation quietly.
      if (terminal && !spoke && !closing && !stopped && latestDelegationId === delegationId) {
        if (rerun)
          append("session.thinking.append", "Nothing new reached my chat for that.", delegationId);
        else rerunAfterTranscript(delegationId, sequence, heard);
      }
    } catch (cause) {
      if (!abort.signal.aborted && !closing && !stopped && latestDelegationId === delegationId) {
        if (
          attempt < 2 &&
          (cause instanceof TypeError ||
            (cause instanceof Error && cause.message.startsWith("Task updates disconnected")))
        ) {
          const timer = setTimeout(
            () => {
              delegationTimers.delete(timer);
              void runDelegation(delegationId, sequence, attempt + 1, rerun);
            },
            1_000 * (attempt + 1),
          );
          delegationTimers.add(timer);
          return;
        }
        const message =
          cause instanceof Error
            ? cause.message
            : "Delegated work could not be confirmed. Check agent activity.";
        callbacks.onWorkingChange?.(false);
        callbacks.onError?.(message);
        append("session.commentary.append", message, delegationId);
      }
    } finally {
      workStreams.delete(abort);
    }
  };
  const onEvent = (raw: string) => {
    if (stopped || raw.length > MAX_WIRE_EVENT_CHARS) return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Predicate.isObject(event) || typeof event.type !== "string") return;
    if (typeof event.event_id === "string") {
      if (handledEvents.has(event.event_id)) return;
      handledEvents.add(event.event_id);
      if (handledEvents.size > 2_048) handledEvents.delete(handledEvents.values().next().value!);
    }
    if (event.type === "session.started") {
      if (closing) return;
      ready = true;
      lastActivity = Date.now();
      for (const track of sent?.getAudioTracks() ?? []) track.enabled = !muted;
      if (muted) send({ type: "session.input_audio.mute" });
      callbacks.onSessionReady?.({ model, voice });
      setState("listening");
      readyResolve?.();
      readyResolve = null;
      readyReject = null;
      return;
    }
    if (event.type === "session.usage.updated" || event.type === "session.closed") {
      if (
        Predicate.isObject(event.usage) &&
        typeof event.usage.seconds === "number" &&
        Number.isFinite(event.usage.seconds) &&
        event.usage.seconds >= 0
      )
        usageSeconds = Math.max(usageSeconds, event.usage.seconds);
      finalized =
        event.type === "session.closed" &&
        Predicate.isObject(event.usage) &&
        typeof event.usage.seconds === "number" &&
        Number.isFinite(event.usage.seconds) &&
        event.usage.seconds >= 0;
      reportUsage();
      if (event.type === "session.closed") {
        const wasClosing = closing;
        cleanup();
        if (!wasClosing) callbacks.onEndedByVoice?.();
      }
      return;
    }
    if (event.type === "error") {
      callbacks.onError?.(
        "GPT-Live rejected a session command. Check the connection or restart voice; delegated tasks remain in agent activity.",
      );
      if (!ready) {
        readyReject?.(new Error("GPT-Live did not accept the session."));
        cleanup();
      }
      return;
    }
    const fragment = parseLiveTranscript(event);
    if (fragment) {
      context.append(fragment);
      lastActivity = Date.now();
      if (fragment.role === "user") userFragments += 1;
      const pending = transcripts[fragment.role];
      pending.text += fragment.text;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        flush(fragment.role);
        if (fragment.role === "user") for (const settled of userTranscriptSettled) settled();
      }, 800);
      if (pending.text.length > 4_000) flush(fragment.role);
      return;
    }
    if (
      event.type === "session.delegation.created" &&
      ready &&
      !closing &&
      Predicate.isObject(event.delegation) &&
      event.delegation.target === "client" &&
      typeof event.delegation.id === "string" &&
      event.delegation.id.length > 0 &&
      event.delegation.id.length <= 200
    ) {
      const id = event.delegation.id;
      if (handledDelegations.has(id)) return;
      if (handledDelegations.size >= 256) {
        callbacks.onError?.(
          "This voice session reached its task limit. Restart voice to continue.",
        );
        close();
        return;
      }
      handledDelegations.add(id);
      latestDelegationId = id;
      const sequence = handledDelegations.size;
      // Transcripts can trail delegation metadata. Give in-flight fragments a
      // short arrival window, then send bounded conversation context once.
      const timer = setTimeout(() => {
        delegationTimers.delete(timer);
        void runDelegation(id, sequence);
      }, 350);
      delegationTimers.add(timer);
    }
  };
  const start = async () => {
    if (stopped || state !== "idle") return;
    setState("connecting");
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
    // Started now so a caller's lookups run while the microphone opens; only
    // awaited once the offer is ready. The catch keeps an early rejection from
    // surfacing as unhandled before then.
    const extraBody = routes.startBody ? Promise.resolve().then(routes.startBody) : null;
    extraBody?.catch(() => undefined);
    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      if (stopped) return;
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(),
      });
      if (stopped) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      mic = captured;
      mic.getAudioTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (!closing && !stopped) {
            callbacks.onError?.("The microphone disconnected. Reconnect it and start voice again.");
            close();
          }
        }),
      );
      const isolation = await applyVoiceIsolation({
        stream: captured,
        context: audioContext,
        enabled: options.voiceIsolation === true,
      });
      if (stopped) {
        isolation.release();
        isolation.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      releaseIsolation = isolation.release;
      sent = isolation.stream;
      const connection = new RTCPeerConnection();
      peer = connection;
      audio = new Audio();
      audio.autoplay = true;
      let remoteAnalyser: AnalyserNode | null = null;
      const micAnalyser = audioContext.createAnalyser();
      micAnalyser.fftSize = 256;
      audioContext.createMediaStreamSource(captured).connect(micAnalyser);
      const samples = new Uint8Array(256);
      const level = (analyser: AnalyserNode | null) => {
        if (!analyser) return 0;
        analyser.getByteTimeDomainData(samples);
        return Math.sqrt(
          samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length,
        );
      };
      connection.addEventListener("track", (event) => {
        if (stopped || !audio || !audioContext) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = stream;
        remoteAnalyser = audioContext.createAnalyser();
        remoteAnalyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(remoteAnalyser);
        void audio.play().catch(() => {
          if (!stopped) {
            callbacks.onError?.(
              "Audio playback was blocked. Start voice again to enable playback.",
            );
            close();
          }
        });
      });
      connection.addEventListener("connectionstatechange", () => {
        if (stopped) return;
        if (connection.connectionState === "failed") lost();
        else if (connection.connectionState === "disconnected" && !unstableTimer)
          unstableTimer = setTimeout(lost, 8_000);
        else if (connection.connectionState === "connected" && unstableTimer) {
          clearTimeout(unstableTimer);
          unstableTimer = null;
        }
      });
      for (const track of sent.getAudioTracks()) {
        track.enabled = false;
        connection.addTrack(track, sent);
      }
      const events = connection.createDataChannel("oai-events");
      channel = events;
      events.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") onEvent(event.data);
      });
      events.addEventListener("close", lost);
      const offer = await connection.createOffer();
      if (stopped) return;
      await connection.setLocalDescription(offer);
      if (connection.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            connection.removeEventListener("icegatheringstatechange", check);
            opening.signal.removeEventListener("abort", abort);
          };
          const check = () => {
            if (connection.iceGatheringState === "complete") {
              finish();
              resolve();
            }
          };
          const abort = () => {
            finish();
            reject(new Error("Voice startup cancelled."));
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error("Voice connection negotiation timed out."));
          }, 10_000);
          connection.addEventListener("icegatheringstatechange", check);
          opening.signal.addEventListener("abort", abort, { once: true });
          check();
        });
      if (stopped) return;
      const awaitedBody: Readonly<Record<string, unknown>> = extraBody ? await extraBody : {};
      const { history: extraHistory, ...extra } = awaitedBody;
      if (stopped) return;
      const response = await fetch(url(routes.sessionPath), {
        method: "POST",
        headers,
        credentials: "include",
        signal: opening.signal,
        body: JSON.stringify({
          sdp: connection.localDescription?.sdp,
          ...extra,
          // Every caller's history is held to the start request's limits.
          history: trimLiveHistory(
            Array.isArray(extraHistory)
              ? (extraHistory as ReadonlyArray<RecentConversationEntry>)
              : (options.recentHistory ?? []),
          ),
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500) || "GPT-Live could not start.";
        // A leased session's 409 is the host refusing the claim, not a fault.
        if (response.status === 409 && routes.heartbeat && callbacks.onStartRefused) {
          if (stopped) return;
          cleanup();
          callbacks.onStartRefused(detail);
          return;
        }
        throw new Error(detail);
      }
      const result = decodeStart(await response.json());
      sessionId = result.sessionId;
      model = result.model;
      voice = result.voice;
      if (stopped) {
        releaseSession();
        return;
      }
      startHeartbeat();
      reportUsage();
      const started = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      // Install the receipt listener before applying SDP; startup can be immediate.
      const startupTimeout = setTimeout(
        () => readyReject?.(new Error("GPT-Live did not confirm startup.")),
        20_000,
      );
      try {
        await Promise.all([
          connection.setRemoteDescription({ type: "answer", sdp: result.sdp }),
          started,
        ]);
      } finally {
        clearTimeout(startupTimeout);
      }
      if (stopped) return;
      meter = setInterval(() => {
        if (stopped || closing) return;
        const micLevel = level(micAnalyser),
          assistantLevel = level(remoteAnalyser),
          now = Date.now();
        if (assistantLevel > 0.025) {
          lastAudible = now;
          lastActivity = now;
        }
        if (micLevel > 0.035) lastActivity = now;
        const speaking = lastAudible > 0 && now - lastAudible < 600;
        if (mutedOutput && !speaking && audio) {
          audio.muted = false;
          mutedOutput = false;
        }
        setState(speaking && !mutedOutput ? "speaking" : "listening");
        callbacks.onLevels?.({ mic: micLevel, assistant: mutedOutput ? 0 : assistantLevel });
        if (endAfterAudio && !speaking) {
          close();
          return;
        }
        if (
          options.silenceTimeoutSeconds &&
          now - lastActivity > options.silenceTimeoutSeconds * 1_000
        ) {
          callbacks.onIdleTimeout?.();
          close();
        }
      }, 100);
    } catch (cause) {
      if (!stopped) {
        cleanup();
        setState("error");
        callbacks.onError?.(cause instanceof Error ? cause.message : "Could not start GPT-Live.");
      }
    }
  };
  return {
    start,
    stop: close,
    announce: (text) => append("session.commentary.append", text, null),
    endAfterReply: () => {
      if (state === "speaking") endAfterAudio = true;
      else close();
    },
    hush: () => {
      if (audio && ready) {
        audio.muted = true;
        mutedOutput = true;
        append("session.instructions.append", "Stop speaking and listen to the user.", null);
        setState("listening");
      }
    },
    setMuted: (next) => {
      if (muted === next) return;
      muted = next;
      // Before startup the flag is applied when the session starts.
      if (!ready || closing || stopped) return;
      for (const track of sent?.getAudioTracks() ?? []) track.enabled = !muted;
      send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
    },
    get state() {
      return state;
    },
  };
}
