import {
  ORCHESTRATOR_LIVE_SESSION_PATH,
  ORCHESTRATOR_LIVE_DELEGATION_PATH,
  OrchestratorLiveStartResult,
  OrchestratorLiveWorkEvent,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type {
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceSessionOptions,
  VoiceSessionState,
} from "./realtimeSession";
import { applyVoiceIsolation, microphoneConstraints } from "./voiceIsolation";
import { createLiveTranscriptContext, liveAppendChunks, parseLiveTranscript } from "./liveProtocol";

const decodeStart = Schema.decodeUnknownSync(OrchestratorLiveStartResult);
const decodeWork = Schema.decodeUnknownSync(OrchestratorLiveWorkEvent);
const terminalWork = new Set(["completed", "failed", "cancelled", "expired"]);
const MAX_WIRE_EVENT_CHARS = 100_000;

/** GPT-Live has its own full-duplex protocol. Realtime response/VAD commands
 * must never be sent on this channel. Backend task lifetime is independent. */
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
  let meter: ReturnType<typeof setInterval> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let unstableTimer: ReturnType<typeof setTimeout> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let model = options.model ?? "gpt-live-1";
  let voice = "marin";
  const opening = new AbortController();
  const workStreams = new Set<AbortController>();
  const delegationTimers = new Set<ReturnType<typeof setTimeout>>();
  const handledEvents = new Set<string>();
  const handledDelegations = new Set<string>();
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
    if (!sessionId) return;
    void fetch(url(`${ORCHESTRATOR_LIVE_SESSION_PATH}/release`), {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => undefined);
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    closing = true;
    ready = false;
    readyReject?.(new Error("Voice session ended before startup completed."));
    readyResolve = null;
    readyReject = null;
    opening.abort();
    if (meter) clearInterval(meter);
    if (closeTimer) clearTimeout(closeTimer);
    if (unstableTimer) clearTimeout(unstableTimer);
    for (const timer of delegationTimers) clearTimeout(timer);
    delegationTimers.clear();
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
  const runDelegation = async (delegationId: string, sequence: number, attempt = 0) => {
    if (closing || stopped || !sessionId || latestDelegationId !== delegationId) return;
    if (!context.hasUserSpeech()) {
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
    try {
      const response = await fetch(url(ORCHESTRATOR_LIVE_DELEGATION_PATH), {
        method: "POST",
        headers,
        credentials: "include",
        signal: abort.signal,
        body: JSON.stringify({ sessionId, delegationId, sequence, context: context.context() }),
      });
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
              void runDelegation(delegationId, sequence, attempt + 1);
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
      for (const track of sent?.getAudioTracks() ?? []) track.enabled = true;
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
      const pending = transcripts[fragment.role];
      pending.text += fragment.text;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => flush(fragment.role), 800);
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
      const response = await fetch(url(ORCHESTRATOR_LIVE_SESSION_PATH), {
        method: "POST",
        headers,
        credentials: "include",
        signal: opening.signal,
        body: JSON.stringify({
          sdp: connection.localDescription?.sdp,
          history: (options.recentHistory ?? [])
            .slice(-24)
            .map((entry) => ({ role: entry.role, text: entry.text.slice(-4_000) })),
        }),
      });
      if (!response.ok)
        throw new Error((await response.text()).slice(0, 500) || "GPT-Live could not start.");
      const result = decodeStart(await response.json());
      sessionId = result.sessionId;
      model = result.model;
      voice = result.voice;
      if (stopped) {
        releaseSession();
        return;
      }
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
    get state() {
      return state;
    },
  };
}
