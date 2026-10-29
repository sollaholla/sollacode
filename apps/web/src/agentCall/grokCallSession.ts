import {
  AGENT_CALL_GROK_DELEGATE_TOOL,
  AgentCallGrokSessionStartResult,
  OrchestratorLiveWorkEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isAssistantGoodbye, isPersonGoodbye } from "../orchestrator/farewell";
import { createLiveTranscriptContext, trimLiveHistory } from "../orchestrator/liveProtocol";
import {
  createDeskSounds,
  createPhoneLine,
  type DeskSounds,
  type PhoneLine,
} from "../orchestrator/phoneLine";
import type {
  RealtimeFunctionTool,
  RecentConversationEntry,
} from "../orchestrator/realtimeProtocol";
import {
  createVoiceSession,
  type VoiceSession,
  type VoiceSessionCallbacks,
  type VoiceSessionOptions,
  type VoiceSessionState,
} from "../orchestrator/realtimeSession";
import { DEFAULT_VOICE_CUE_POLICY } from "../orchestrator/voiceCues";

const decodeStart = Schema.decodeUnknownSync(AgentCallGrokSessionStartResult);
const decodeWork = Schema.decodeUnknownSync(OrchestratorLiveWorkEvent);
const terminalWork = new Set(["completed", "failed", "cancelled", "expired"]);
const MAX_WIRE_EVENT_CHARS = 100_000;
/** Longest wait for the person's words before re-asking a delegation that found nothing new. */
const TRAILING_TRANSCRIPT_MS = 1_500;
/** The host refuses a delegation sequence past this (`OrchestratorLiveDelegationInput`). */
const MAX_DELEGATIONS = 256;

/** The one tool a Grok call's voice has: hand what the person said to its chat. */
export const GROK_CALL_TOOLS: ReadonlyArray<RealtimeFunctionTool> = [
  {
    type: "function",
    name: AGENT_CALL_GROK_DELEGATE_TOOL,
    description:
      "Pass what the person just said to your chat, which does your real work: anything that needs action, information, files, tools or a decision about work, and the person's answers to your chat's questions. Returns at once; your chat's reply reaches you later as an update.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Told to the voice when it answers right after handing words to its chat. */
export const GROK_CALL_TOOL_REPLY =
  "Your chat has it and is working on it. Say one short line that you've passed it on. Don't guess at the result, and don't say it is done.";

/** What the voice is told to say when its chat replies. */
export const grokCallReply = (text: string) => `Your chat replied: ${text}`;

/**
 * An agent call on Grok Voice: the orchestrator's realtime session over xAI's
 * WebSocket, started from the call's host with the agent's instructions and
 * one tool, `ask_your_chat`. Everything around it is the call's, as for
 * GPT-Live (`liveSession.ts`): the host's lease (heartbeat, release), the
 * transcript context each delegation carries, the chat's replies spoken back
 * as they stream in, goodbye hang-up, and the phone line with the agent's desk
 * behind it while its chat works. `options.live` names the call's routes.
 */
export function createGrokCallSession(
  options: VoiceSessionOptions,
  callbacks: VoiceSessionCallbacks,
): VoiceSession {
  const routes = options.live;
  if (!routes) throw new Error("A Grok call needs its host's call routes.");
  const headers = {
    "content-type": "application/json",
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
  // See liveSession: cookies only stand in for a bearer on the same origin.
  const credentials: RequestCredentials = options.bearerToken ? "omit" : "include";
  const url = (path: string) => `${options.httpBaseUrl.replace(/\/$/, "")}${path}`;

  let sessionId: string | null = null;
  let stopped = false;
  let released = false;
  let startedAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const context = createLiveTranscriptContext(options.recentHistory);
  /** Finished user transcripts so far; a delegation notes the count it was sent with. */
  let userFragments = 0;
  const userTranscriptArrived = new Set<() => void>();
  let lastUserWords = "";
  let endedByGoodbye = false;
  let sequence = 0;
  let latestDelegationId: string | null = null;
  const workStreams = new Set<AbortController>();
  const delegationTimers = new Set<ReturnType<typeof setTimeout>>();
  let working = false;
  let voiceLine: PhoneLine | null = null;
  let desk: {
    readonly context: AudioContext;
    readonly line: PhoneLine;
    readonly sounds: DeskSounds;
    timer: ReturnType<typeof setInterval> | null;
  } | null = null;

  const deskVolume = () => {
    const cues = options.cuePolicy?.() ?? DEFAULT_VOICE_CUE_POLICY;
    return cues.enabled ? cues.volume : 0;
  };

  /** Plays the desk while the chat works and the voice is quiet; created on first use. */
  const syncDesk = () => {
    if (!options.phoneLine) return;
    if (working && desk === null && !stopped) {
      try {
        const deskContext = new AudioContext();
        void deskContext.resume().catch(() => undefined);
        const line = createPhoneLine(deskContext);
        const sounds = createDeskSounds({
          context: deskContext,
          destination: line.input,
          volume: deskVolume,
        });
        desk = { context: deskContext, line, sounds, timer: null };
      } catch {
        return;
      }
    }
    if (desk === null) return;
    if (working && desk.timer === null) {
      const playing = desk;
      playing.timer = setInterval(() => {
        // The agent stops typing to talk.
        playing.sounds.setActive(working && session.state !== "speaking");
        playing.sounds.pump();
      }, 100);
    } else if (!working && desk.timer !== null) {
      clearInterval(desk.timer);
      desk.timer = null;
      desk.sounds.setActive(false);
    }
  };

  const setWorking = (next: boolean) => {
    if (working === next) return;
    working = next;
    callbacks.onWorkingChange?.(next);
    syncDesk();
  };

  const releaseSession = () => {
    if (!sessionId || released) return;
    released = true;
    void fetch(url(routes.releasePath), {
      method: "POST",
      headers,
      credentials,
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => undefined);
  };
  const onPageHide = () => releaseSession();

  /** Ends everything around the voice; the voice itself is stopped by the caller. */
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const timer of delegationTimers) clearTimeout(timer);
    delegationTimers.clear();
    userTranscriptArrived.clear();
    for (const stream of workStreams) stream.abort();
    workStreams.clear();
    setWorking(false);
    if (desk) {
      if (desk.timer) clearInterval(desk.timer);
      desk.sounds.dispose();
      desk.line.disconnect();
      void desk.context.close().catch(() => undefined);
      desk = null;
    }
    voiceLine?.disconnect();
    voiceLine = null;
    releaseSession();
  };

  /** The host refused a leased session (409): the call is over there already. */
  const gone = () => {
    if (stopped) return;
    released = true;
    cleanup();
    inner.stop();
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
        credentials,
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

  /** Claims the call on its host and hands the realtime session what to open. */
  const startOnHost = async () => {
    const extra = routes.startBody ? await routes.startBody() : {};
    const { history, ...rest } = extra;
    const response = await fetch(url(routes.sessionPath), {
      method: "POST",
      headers,
      credentials,
      body: JSON.stringify({
        ...rest,
        history: trimLiveHistory(
          Array.isArray(history)
            ? (history as ReadonlyArray<RecentConversationEntry>)
            : (options.recentHistory ?? []),
        ),
      }),
    });
    if (!response.ok) {
      const detail =
        (await response.text()).slice(0, 500) || "Grok Voice could not start the call.";
      // The host refusing the claim ("Answered on <device>") is not a fault.
      if (response.status === 409 && callbacks.onStartRefused && !stopped) {
        cleanup();
        callbacks.onStartRefused(detail);
      }
      throw new Error(detail);
    }
    const result = decodeStart(await response.json());
    sessionId = result.sessionId;
    if (stopped) {
      releaseSession();
      throw new Error("The call ended before it connected.");
    }
    startedAt = Date.now();
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
    startHeartbeat();
    return {
      value: result.clientSecret,
      model: result.model,
      voice: result.voice,
      instructions: result.instructions,
      tools: GROK_CALL_TOOLS,
    };
  };

  const noteTranscript = (role: "user" | "assistant", text: string) => {
    const at = Math.max(0, Date.now() - startedAt);
    // Leading space: the host joins fragments as they come, like GPT-Live's deltas.
    context.append({ role, text: ` ${text}`, startMs: at, endMs: at + 1 });
    if (role === "user") {
      lastUserWords = text;
      userFragments += 1;
      // A copy: a waiter that asks again adds a new waiter, which must wait for the next words.
      for (const arrived of Array.from(userTranscriptArrived)) arrived();
      return;
    }
    // Grok has no tool to hang up with either: a goodbye the person said,
    // answered in kind, ends the call once that goodbye has been spoken.
    if (!endedByGoodbye && isAssistantGoodbye(text) && isPersonGoodbye(lastUserWords)) {
      endedByGoodbye = true;
      inner.endAfterReply();
    }
  };

  /** Asks again, once, when the person's words trail the tool call that should carry them. */
  const rerunAfterTranscript = (delegationId: string, at: number, heard: number) => {
    const run = () => {
      userTranscriptArrived.delete(run);
      clearTimeout(timer);
      delegationTimers.delete(timer);
      void runDelegation(delegationId, at, 0, true);
    };
    const timer = setTimeout(run, userFragments > heard ? 0 : TRAILING_TRANSCRIPT_MS);
    delegationTimers.add(timer);
    if (userFragments <= heard) userTranscriptArrived.add(run);
  };

  /**
   * Hands everything said since the last delegation to the agent's chat (the
   * host works out what is new and who it is for) and speaks the replies as
   * they stream back. Only the newest delegation is followed.
   */
  const runDelegation = async (
    delegationId: string,
    at: number,
    attempt = 0,
    rerun = false,
  ): Promise<void> => {
    if (stopped || !sessionId || latestDelegationId !== delegationId) return;
    const heard = userFragments;
    if (!context.hasUserSpeech()) {
      if (!rerun) rerunAfterTranscript(delegationId, at, heard);
      else inner.announce("You didn't catch that. Ask the person to say it again.");
      return;
    }
    const abort = new AbortController();
    workStreams.add(abort);
    setWorking(true);
    let terminal = false;
    try {
      const response = await fetch(url(routes.delegationPath), {
        method: "POST",
        headers,
        credentials,
        signal: abort.signal,
        body: JSON.stringify({ sessionId, delegationId, sequence: at, context: context.context() }),
      });
      if (response.status === 409) {
        await response.body?.cancel();
        gone();
        return;
      }
      if (!response.ok)
        throw new Error(
          (await response.text()).slice(0, 500) || "Your chat could not take the request.",
        );
      if (latestDelegationId !== delegationId || stopped) {
        await response.body?.cancel();
        return;
      }
      for (const previous of workStreams) if (previous !== abort) previous.abort();
      if (!response.body) throw new Error("No task update stream was returned.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let lastText = "";
      let spoke = false;
      try {
        for (;;) {
          if (stopped || latestDelegationId !== delegationId) break;
          const chunk = await reader.read();
          if (stopped || latestDelegationId !== delegationId) break;
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          if (pending.length > MAX_WIRE_EVENT_CHARS)
            throw new Error("Your chat returned an oversized update.");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = decodeWork(JSON.parse(line));
            terminal = terminalWork.has(event.status);
            setWorking(
              !terminal && event.status !== "waiting-input" && event.status !== "pending-approval",
            );
            const audible =
              terminal || event.status === "waiting-input" || event.status === "pending-approval";
            if (audible && event.text.trim() && event.text !== lastText) {
              inner.announce(grokCallReply(event.text));
              spoke = true;
            }
            lastText = event.text;
          }
          if (chunk.done || terminal) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!terminal && !stopped && latestDelegationId === delegationId)
        throw new Error("Updates from your chat disconnected. The work may still be running.");
      // Nothing new reached the chat: the person's words may still be coming.
      if (terminal && !spoke && !rerun && !stopped && latestDelegationId === delegationId)
        rerunAfterTranscript(delegationId, at, heard);
    } catch (cause) {
      if (abort.signal.aborted || stopped || latestDelegationId !== delegationId) return;
      if (
        attempt < 2 &&
        (cause instanceof TypeError ||
          (cause instanceof Error && cause.message.startsWith("Updates from your chat")))
      ) {
        const timer = setTimeout(
          () => {
            delegationTimers.delete(timer);
            void runDelegation(delegationId, at, attempt + 1, rerun);
          },
          1_000 * (attempt + 1),
        );
        delegationTimers.add(timer);
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "Your chat could not be reached. Check its chat.";
      setWorking(false);
      callbacks.onError?.(message);
      inner.announce(message);
    } finally {
      workStreams.delete(abort);
    }
  };

  const delegate = () => {
    if (stopped || !sessionId) return { error: "The call has ended." };
    if (sequence >= MAX_DELEGATIONS) return { error: "This call can't hand over anything more." };
    sequence += 1;
    const delegationId = `${sessionId}:${sequence}`;
    latestDelegationId = delegationId;
    void runDelegation(delegationId, sequence);
    return { status: "Your chat has it and is working on it." };
  };

  // The call's own engine, never GPT-Live: no model, routes or line of GPT-Live's.
  const { model: _model, live: _live, phoneLine: _phoneLine, ...realtimeOptions } = options;
  const inner = createVoiceSession(
    {
      ...realtimeOptions,
      // The orchestrator's state tones have no place on a phone call.
      cuePolicy: () => ({ enabled: false, volume: 0 }),
      realtimeCall: {
        start: startOnHost,
        toolReplyInstructions: GROK_CALL_TOOL_REPLY,
        ...(options.phoneLine
          ? {
              playbackDestination: (audio: AudioContext) => {
                voiceLine ??= createPhoneLine(audio);
                return voiceLine.input;
              },
            }
          : {}),
      },
    },
    {
      ...callbacks,
      onToolCall: async ({ name }) =>
        name === AGENT_CALL_GROK_DELEGATE_TOOL ? delegate() : { error: `Unknown tool ${name}.` },
      onTranscript: (entry) => {
        if (!stopped) noteTranscript(entry.role, entry.text);
        callbacks.onTranscript?.(entry);
      },
      // The session's own "thinking" is not the chat working; `setWorking` reports that.
      onWorkingChange: () => undefined,
      onStateChange: (next: VoiceSessionState) => {
        // The voice ended itself (a goodbye, a transfer, a lost socket): free the host.
        if (next === "idle" || next === "error") cleanup();
        callbacks.onStateChange?.(next);
      },
    },
  );

  const session: VoiceSession = {
    start: () => inner.start(),
    stop: () => {
      cleanup();
      inner.stop();
    },
    announce: (text) => inner.announce(text),
    endAfterReply: () => inner.endAfterReply(),
    hush: () => inner.hush(),
    setMuted: (muted) => inner.setMuted?.(muted),
    instruct: (text) => inner.instruct?.(text),
    get state() {
      return inner.state;
    },
  };
  return session;
}
