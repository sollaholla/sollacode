import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_BOUNDARY_MARKER,
  buildAnnouncementInstructions,
  buildInstructions,
  describeNegotiationFailure,
  describeRealtimeError,
  buildResponseCreateFrame,
  buildSessionUpdate,
  buildToolOutputFrame,
  END_OF_SPEECH_SILENCE_MS,
  GROK_END_OF_SPEECH_SILENCE_MS,
  DESTRUCTIVE_TOOL_NAMES,
  isLikelyEchoFragment,
  isLikelyHallucinatedTranscript,
  parseRealtimeEvent,
  parseToolArguments,
  supportsReasoningEffort,
  toolsForAuthority,
} from "./realtimeProtocol";

const toolNames = (authority: Parameters<typeof toolsForAuthority>[0]) =>
  toolsForAuthority(authority).map((tool) => tool.name);

describe("toolsForAuthority", () => {
  it("exposes only read tools at read-only", () => {
    expect(toolNames("read-only")).toEqual([
      "list_threads",
      "describe_thread",
      "read_thread",
      "search_threads",
      "end_voice_session",
      "get_orchestrator_settings",
      "get_runtime_state",
      "open_website",
      "run_command",
      "get_usage",
      "list_project_files",
      "read_project_file",
      "find_project_files",
      "search_project",
      "list_terminals",
      "read_terminal",
    ]);
  });

  it("adds sending at send, without control tools", () => {
    const names = toolNames("send");
    expect(names).toContain("send_to_thread");
    expect(names).toContain("write_to_terminal");
    // A misheard "stop" must not be actionable at this level.
    expect(names).not.toContain("interrupt_thread");
    // Nor may it hand an agent broader permissions.
    expect(names).not.toContain("update_thread_settings");
  });

  it("adds control tools only at full", () => {
    expect(toolNames("full")).toEqual([
      "list_threads",
      "describe_thread",
      "read_thread",
      "search_threads",
      "end_voice_session",
      "set_orchestrator_voice",
      "get_orchestrator_settings",
      "get_runtime_state",
      "open_website",
      "run_command",
      "create_project",
      "approve_proposed_plan",
      "get_usage",
      "list_project_files",
      "read_project_file",
      "find_project_files",
      "search_project",
      "list_terminals",
      "read_terminal",
      "send_to_thread",
      "write_to_terminal",
      "create_thread",
      "create_side_chat",
      "rename_thread",
      "settle_thread",
      "update_thread_settings",
      "interrupt_thread",
    ]);
  });

  it("offers a reason parameter on every tool", () => {
    // The tool log is only readable if the model says why it called something.
    for (const tool of toolsForAuthority("full")) {
      const properties = tool.parameters.properties as Record<string, unknown>;
      expect(properties.reason, `${tool.name} must accept a reason`).toBeDefined();
    }
  });

  it("marks exactly the control tools destructive", () => {
    for (const name of DESTRUCTIVE_TOOL_NAMES) {
      expect(toolNames("full")).toContain(name);
    }
    expect(DESTRUCTIVE_TOOL_NAMES.has("send_to_thread")).toBe(false);
    expect(DESTRUCTIVE_TOOL_NAMES.has("list_threads")).toBe(false);
    expect(DESTRUCTIVE_TOOL_NAMES.has("update_thread_settings")).toBe(true);
  });

  it("declares every tool as a top-level object schema", () => {
    // Same constraint the MCP tools have: providers reject non-object roots.
    for (const tool of toolsForAuthority("full")) {
      expect(tool.parameters.type, `${tool.name} must be an object schema`).toBe("object");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe("Orchestrator action chaining instructions", () => {
  it("requires a history-derived rename to finish with the rename tool", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });

    expect(instructions).toContain("read_thread is research and rename_thread is the completion");
    const renameTool = toolsForAuthority("full").find((tool) => tool.name === "rename_thread");
    expect(renameTool?.description).toContain("call this tool next");
  });
});

describe("describeRealtimeError", () => {
  it("names a spent account instead of passing the raw wording through", () => {
    // This cost a long debugging session that ended at a credit balance: the
    // session failed on connect every time, and nothing said why.
    const spoken = describeRealtimeError({
      message: "You have no credits remaining. Add credits to continue using the API at ...",
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
    });
    expect(spoken).toContain("no credits left");
    expect(spoken).toContain("nothing is wrong with the app");
  });

  it("recognises the quota failure from either field", () => {
    expect(describeRealtimeError({ message: "x", code: "", type: "insufficient_quota" })).toContain(
      "no credits left",
    );
  });

  it("passes an ordinary error through untouched", () => {
    expect(
      describeRealtimeError({
        message: "Conversation already has an active response.",
        code: "conflict",
        type: "invalid_request_error",
      }),
    ).toBe("Conversation already has an active response.");
  });
});

describe("describeNegotiationFailure", () => {
  it("uses the reason the API actually gave", () => {
    // This body used to be dropped for "Could not negotiate the voice session",
    // which is true of every cause and useful for none.
    const spoken = describeNegotiationFailure(
      400,
      JSON.stringify({
        error: { message: "Offer did not have an audio media section.", code: "invalid_offer" },
      }),
    );
    expect(spoken).toBe("Offer did not have an audio media section.");
  });

  it("names a spent account rather than repeating the API wording", () => {
    const spoken = describeNegotiationFailure(
      400,
      JSON.stringify({
        error: {
          message: "You have no credits remaining.",
          code: "credit_balance_exhausted",
          type: "insufficient_quota",
        },
      }),
    );
    expect(spoken).toContain("no credits left");
  });

  it("still says something useful for a billing status with no body", () => {
    expect(describeNegotiationFailure(402, "")).toContain("credits");
    expect(describeNegotiationFailure(429, "not json")).toContain("credits");
  });

  it("falls back to the status when there is nothing else to go on", () => {
    expect(describeNegotiationFailure(500, "")).toContain("500");
  });
});

describe("buildInstructions", () => {
  it("tells the model to read intent rather than match wording", () => {
    // Reported as "the model is SO freaking literal": a phrase describing a
    // capability was treated as a name to look up and came back as a denial
    // that any such thing existed.
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(instructions).toContain("Read what the user means, not the exact words they used");
    expect(instructions).toContain("Never answer that something does not exist");
  });

  it("tells a read-only orchestrator to refuse actions", () => {
    const instructions = buildInstructions({
      authority: "read-only",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(instructions).toContain("read-only");
  });

  it("demands confirmation before destructive actions when configured", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(instructions).toContain("wait for the user to confirm");
  });

  it("omits the confirmation rule when the user turned it off", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: false,
      language: "en",
    });
    expect(instructions).not.toContain("wait for the user to confirm");
  });

  it("never asks the model to read ids aloud", () => {
    expect(
      buildInstructions({ authority: "full", confirmDestructiveActions: true, language: "en" }),
    ).toContain("never by id");
  });
});

describe("reasoning effort", () => {
  it("asks for high effort on models that support reasoning", () => {
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
      model: "gpt-realtime-2.1",
    });
    expect(update.session.reasoning).toEqual({ effort: "high" });
  });

  it("omits reasoning for models that reject it", () => {
    // The original gpt-realtime fails the whole session.update if a reasoning
    // block is present, which would kill the session at startup.
    for (const model of ["gpt-realtime", "gpt-4o-realtime-preview"]) {
      const update = buildSessionUpdate({
        authority: "full",
        confirmDestructiveActions: true,
        language: "en",
        model,
      });
      expect(update.session.reasoning, `${model} must not carry reasoning`).toBeUndefined();
    }
  });

  it("omits reasoning when the model is unknown", () => {
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(update.session.reasoning).toBeUndefined();
  });

  it("recognises the whole gpt-realtime-2 family", () => {
    expect(supportsReasoningEffort("gpt-realtime-2")).toBe(true);
    expect(supportsReasoningEffort("gpt-realtime-2.1-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-realtime")).toBe(false);
    expect(supportsReasoningEffort("gpt-realtime-mini")).toBe(false);
  });

  it("asks for high effort on Grok Voice models", () => {
    expect(supportsReasoningEffort("grok-voice-latest")).toBe(true);
    expect(supportsReasoningEffort("grok-voice-think-fast-2.0")).toBe(true);
  });
});

describe("buildSessionUpdate", () => {
  it("carries the tools and instructions for the authority", () => {
    const update = buildSessionUpdate({
      authority: "send",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(update.type).toBe("session.update");
    const tools = update.session.tools as ReadonlyArray<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("send_to_thread");
    expect(tools.map((tool) => tool.name)).not.toContain("interrupt_thread");
  });

  it("shapes a Grok session the way the xAI Speech-to-Speech docs describe", () => {
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "es",
      model: "grok-voice-latest",
      provider: "xai",
      voice: "eve",
    });
    expect(update.session.type).toBeUndefined();
    expect(update.session.voice).toBe("eve");
    expect(update.session.reasoning).toEqual({ effort: "high" });
    const session = update.session as {
      turn_detection: {
        type: string;
        idle_timeout_ms: null;
        silence_duration_ms: number;
      };
      audio: {
        input: {
          format: { type: string; rate: number };
          transcription: { model: string; language_hint: string };
        };
      };
    };
    expect(session.turn_detection.type).toBe("server_vad");
    expect(session.turn_detection.idle_timeout_ms).toBeNull();
    expect(session.turn_detection.silence_duration_ms).toBe(GROK_END_OF_SPEECH_SILENCE_MS);
    expect(session.turn_detection.silence_duration_ms).toBeGreaterThan(END_OF_SPEECH_SILENCE_MS);
    expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(session.audio.input.transcription).toEqual({
      model: "grok-transcribe",
      language_hint: "es-MX",
    });
  });
});

describe("parseRealtimeEvent xAI events", () => {
  it("treats a streaming transcription update as a user delta", () => {
    expect(
      parseRealtimeEvent({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "item-9",
        transcript: "hello there",
      }),
    ).toEqual({ kind: "user-transcript-delta", text: "hello there", itemId: "item-9" });
  });

  it("exposes assistant audio deltas for the WebSocket player", () => {
    expect(parseRealtimeEvent({ type: "response.output_audio.delta", delta: "AAAA" })).toEqual({
      kind: "assistant-audio-delta",
      audio: "AAAA",
    });
  });

  it("names an xAI spent account from an in-band error", () => {
    const event = parseRealtimeEvent(
      {
        type: "error",
        error: { message: "no credits remaining", code: "credit_balance_exhausted" },
      },
      "xai",
    );
    expect(event.kind).toBe("error");
    if (event.kind === "error") {
      expect(event.message).toContain("console.x.ai");
    }
  });
});

describe("language pinning", () => {
  it("anchors the spoken language by name", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    // The model has opened conversations in French unprompted; the pin is the fix.
    expect(instructions).toContain("Always speak English");
  });

  it("surfaces the server's configuration ack, which gates the microphone", () => {
    // Until this arrives the session is on API defaults — no language pin, no
    // instructions — so a word spoken into that window came back in whatever
    // language the transcriber guessed. "hi" came back as Japanese.
    expect(parseRealtimeEvent({ type: "session.updated" })).toEqual({
      kind: "session-configured",
    });
  });

  it("falls back to naming the ISO code for unmapped languages", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "sw",
    });
    expect(instructions).toContain('ISO code "sw"');
  });

  it("waits out pauses and ignores brief noise", () => {
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    const audio = update.session.audio as {
      input: {
        turn_detection: {
          type: string;
          threshold: number;
          silence_duration_ms: number;
          prefix_padding_ms: number;
          idle_timeout_ms: number | null;
        };
      };
    };
    const detection = audio.input.turn_detection;
    expect(detection.type).toBe("server_vad");
    // The API defaults (0.5 / 500ms) answered coughs and keyboard noise, and
    // cut people off whenever they paused to think mid-sentence.
    expect(detection.threshold).toBeGreaterThan(0.5);
    expect(detection.silence_duration_ms).toBeGreaterThan(500);
    // Padding keeps the start of a raised voice from being clipped.
    expect(detection.prefix_padding_ms).toBeGreaterThan(0);
  });

  it("never speaks into silence on its own", () => {
    // `idle_timeout_ms` makes the server commit an empty buffer and generate a
    // response to prompt the user to keep talking. Sent explicitly rather than
    // left to the default so it cannot arrive later as a change of default.
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    const audio = update.session.audio as {
      input: { turn_detection: Record<string, unknown> };
    };
    expect(audio.input.turn_detection).toHaveProperty("idle_timeout_ms", null);
  });

  it("enables input transcription with the language hint", () => {
    const update = buildSessionUpdate({
      authority: "full",
      confirmDestructiveActions: true,
      language: "de",
    });
    // Without this block OpenAI never emits user transcription events at all,
    // and mis-detected audio can flip the conversation's language.
    const audio = update.session.audio as {
      input: { transcription: { model: string; language: string } };
    };
    expect(audio.input.transcription.language).toBe("de");
    expect(audio.input.transcription.model.length).toBeGreaterThan(0);
  });
});

describe("recent history context", () => {
  it("folds recent exchanges into the instructions, newest kept under budget", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
      recentHistory: [
        { role: "user", text: "How is the rover thread doing?" },
        { role: "assistant", text: "Rover is still building." },
      ],
    });
    expect(instructions).toContain("User: How is the rover thread doing?");
    expect(instructions).toContain("You: Rover is still building.");
    // A new session is a NEW conversation. Told to "pick up where this left
    // off", the model resumed a finished exchange — re-answering a question or
    // carrying on a task the user had moved past.
    expect(instructions).toContain("This is a NEW conversation");
    expect(instructions).toContain("Do not resume, repeat or complete anything from it");
    // Bounded by a literal marker, which models follow far more reliably than
    // an adjective, so memory cannot be read as the current turn.
    expect(instructions).toContain(SESSION_BOUNDARY_MARKER);
    // Still not a stranger: the point is a fresh start, not amnesia.
    expect(instructions).toContain("do not greet them as a stranger");
  });

  it("drops the oldest entries when the history exceeds its budget", () => {
    const filler = "x".repeat(600);
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
      recentHistory: [
        { role: "user", text: `oldest ${filler}` },
        { role: "user", text: `middle ${filler}` },
        { role: "user", text: `newer ${filler}` },
        { role: "user", text: `newest ${filler}` },
        { role: "assistant", text: "short tail" },
      ],
    });
    expect(instructions).toContain("short tail");
    expect(instructions).toContain("newest");
    expect(instructions).not.toContain("oldest");
  });

  it("omits the history preamble entirely when there is none", () => {
    const instructions = buildInstructions({
      authority: "full",
      confirmDestructiveActions: true,
      language: "en",
    });
    expect(instructions).not.toContain("most recent exchanges");
  });
});

describe("parseRealtimeEvent", () => {
  it("maps a completed user transcription", () => {
    expect(
      parseRealtimeEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "  what is running?  ",
      }),
    ).toEqual({ kind: "user-transcript", text: "what is running?" });
  });

  it("accepts both spellings of the assistant transcript event", () => {
    // The event was renamed across API revisions; pinning to one goes silent.
    expect(
      parseRealtimeEvent({ type: "response.audio_transcript.done", transcript: "two running" }),
    ).toEqual({ kind: "assistant-transcript", text: "two running" });
    expect(
      parseRealtimeEvent({
        type: "response.output_audio_transcript.done",
        transcript: "two running",
      }),
    ).toEqual({ kind: "assistant-transcript", text: "two running" });
  });

  it("maps a function call", () => {
    expect(
      parseRealtimeEvent({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "list_threads",
        arguments: '{"includeSettled":true}',
      }),
    ).toEqual({
      kind: "tool-call",
      callId: "call-1",
      name: "list_threads",
      argumentsJson: '{"includeSettled":true}',
    });
  });

  it("ignores a function call missing its identity", () => {
    expect(
      parseRealtimeEvent({ type: "response.function_call_arguments.done", name: "list_threads" })
        .kind,
    ).toBe("ignored");
  });

  it("surfaces errors", () => {
    expect(parseRealtimeEvent({ type: "error", error: { message: "bad token" } })).toEqual({
      kind: "error",
      message: "bad token",
    });
  });

  it("tracks the response lifecycle so replies cannot stack up", () => {
    expect(parseRealtimeEvent({ type: "response.created" }).kind).toBe("response-started");
    expect(parseRealtimeEvent({ type: "response.done" }).kind).toBe("response-finished");
  });

  it("tracks speaking state", () => {
    expect(parseRealtimeEvent({ type: "output_audio_buffer.started" }).kind).toBe(
      "speaking-started",
    );
    expect(parseRealtimeEvent({ type: "output_audio_buffer.stopped" }).kind).toBe(
      "speaking-stopped",
    );
  });

  it("ignores unknown and malformed events instead of throwing", () => {
    expect(parseRealtimeEvent({ type: "some.future.event" }).kind).toBe("ignored");
    expect(parseRealtimeEvent(null).kind).toBe("ignored");
    expect(parseRealtimeEvent("nonsense").kind).toBe("ignored");
    expect(parseRealtimeEvent({}).kind).toBe("ignored");
  });
});

describe("parseToolArguments", () => {
  it("decodes an object", () => {
    expect(parseToolArguments('{"threadId":"t1"}')).toEqual({ threadId: "t1" });
  });

  it("falls back to an empty object on malformed or non-object JSON", () => {
    // A model emitting a truncated blob must not take the session down.
    expect(parseToolArguments("{oops")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
    expect(parseToolArguments("null")).toEqual({});
  });
});

describe("frames", () => {
  it("returns a tool result without asking for a reply", () => {
    // Bundling `response.create` in here meant one queued reply per tool call,
    // and the orchestrator answered the same question several times over.
    // Requesting the reply is now the caller's single decision.
    const frame = buildToolOutputFrame({ callId: "call-1", output: { ok: true } });
    expect(frame.type).toBe("conversation.item.create");
    expect(JSON.stringify(frame)).not.toContain("response.create");
  });

  it("builds a bare reply request and an instructed one", () => {
    expect(buildResponseCreateFrame()).toEqual({ type: "response.create" });
    const announced = buildResponseCreateFrame(buildAnnouncementInstructions("Rover finished."));
    expect(announced.type).toBe("response.create");
    // Injecting it as a conversation item would read as the user having spoken.
    expect(JSON.stringify(announced)).toContain("Rover finished.");
  });
});

describe("isLikelyHallucinatedTranscript", () => {
  it("drops stock foreign phrases the transcriber emits for silence", () => {
    // Verbatim from a real session: room noise transcribed as Korean while the
    // session was pinned to English, then persisted as a user message.
    expect(isLikelyHallucinatedTranscript("나도", "en")).toBe(true);
    expect(isLikelyHallucinatedTranscript("字幕", "en")).toBe(true);
    expect(isLikelyHallucinatedTranscript("   ", "en")).toBe(true);
  });

  it("keeps ordinary speech, including punctuation and numbers", () => {
    expect(isLikelyHallucinatedTranscript("Not the website.", "en")).toBe(false);
    expect(isLikelyHallucinatedTranscript("Ship it — 2 threads.", "en")).toBe(false);
    // Accented Latin text still carries Latin letters.
    expect(isLikelyHallucinatedTranscript("¿Qué tal?", "es")).toBe(false);
  });

  it("never filters when the session language is not Latin-script", () => {
    // Guessing would silence a user who configured Korean on purpose.
    expect(isLikelyHallucinatedTranscript("나도", "ko")).toBe(false);
    expect(isLikelyHallucinatedTranscript("字幕", "zh")).toBe(false);
  });
});

describe("isLikelyEchoFragment", () => {
  it("never filters anything while the assistant is silent", () => {
    // Off the clock entirely: a short reply to a question is normal speech.
    expect(isLikelyEchoFragment("sure", false)).toBe(false);
    expect(isLikelyEchoFragment("the build", false)).toBe(false);
  });

  it("drops one- and two-word fragments heard over the assistant", () => {
    // The reported symptom on a phone: the model's own voice returning through
    // the speaker, transcribed as a stray word and read as an interruption.
    expect(isLikelyEchoFragment("thread", true)).toBe(true);
    expect(isLikelyEchoFragment("the thread", true)).toBe(true);
    expect(isLikelyEchoFragment("running now", true)).toBe(true);
  });

  it("keeps words a person means on their own", () => {
    // Saying "stop" over the top of it is the clearest instruction there is,
    // and is exactly what someone does when they want to cut it off.
    for (const word of ["stop", "wait", "yes", "no", "quiet", "cancel", "repeat"]) {
      expect(isLikelyEchoFragment(word, true)).toBe(false);
    }
    expect(isLikelyEchoFragment("no stop", true)).toBe(false);
  });

  it("keeps anything long enough to be a real instruction", () => {
    expect(isLikelyEchoFragment("send that to rover", true)).toBe(false);
  });

  it("ignores punctuation and casing when counting words", () => {
    expect(isLikelyEchoFragment("  Stop!  ", true)).toBe(false);
    expect(isLikelyEchoFragment("...uh, okay?", true)).toBe(false);
    expect(isLikelyEchoFragment("— thread,", true)).toBe(true);
  });

  it("treats an empty transcript as nothing worth passing on", () => {
    expect(isLikelyEchoFragment("   ", true)).toBe(true);
  });
});
