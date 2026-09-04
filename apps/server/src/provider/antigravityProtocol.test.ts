import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  AntigravityLineFramer,
  AntigravityTurnAccumulator,
  buildAntigravityStreamArgs,
  encodeAntigravityUserMessage,
  isAntigravityFailureStatus,
  parseAntigravityEventLine,
  parseAntigravityModelsOutput,
} from "./antigravityProtocol.ts";

/**
 * Captured verbatim from `agy` v1.1.24 running
 * `--input-format stream-json --output-format stream-json --model
 * gemini-3.8-flash-low -p=""` against the prompt "Reply with exactly: OK".
 * The tool list is truncated to keep the fixture readable; nothing here reads
 * more than its first entry.
 */
const GROUND_TRUTH_SESSION: ReadonlyArray<string> = [
  '{"event":"init","conversation_id":"10f67314-1420-4910-a94f-a7e3859ba47e","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/agytest","tools":["view_file","run_command"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"10f67314-1420-4910-a94f-a7e3859ba47e","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"10f67314-1420-4910-a94f-a7e3859ba47e","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  '{"event":"step_update","step_update":{"conversation_id":"10f67314-1420-4910-a94f-a7e3859ba47e","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":0.983891,"usage":{"input_tokens":13713,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13714}}}',
  '{"event":"result","result":{"conversation_id":"10f67314-1420-4910-a94f-a7e3859ba47e","status":"SUCCESS","response":"OK\\n","duration_seconds":1.038124,"num_turns":1,"usage":{"input_tokens":13713,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13714}}}',
];

/**
 * Captured verbatim from a real tool-using turn (`run_command`) with
 * `--dangerously-skip-permissions`. Note `tool_info` is PARTIAL on the ACTIVE
 * frame — `output` only exists once the step reports DONE.
 */
const GROUND_TRUTH_TOOL_STEP: ReadonlyArray<string> = [
  '{"event":"step_update","step_update":{"conversation_id":"9de85713-67cb-46f8-9e84-6dc6809095d6","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat sample.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"9de85713-67cb-46f8-9e84-6dc6809095d6","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.16127,"tool_info":{"name":"run_command","parameters":{"CommandLine":"cat sample.txt"},"output":"cat: sample.txt: No such file or directory\\n"}}}',
];

/** Captured from feeding a line with no `event` field; the CLI exits 1. */
const FRAMING_ERROR_RESULT =
  '{"event":"result","result":{"conversation_id":"f2856e21-7ca3-4d25-9c67-4dd8f6d9657a","status":"ERROR","response":"","error":"stream input message is missing the \\"event\\" field","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}';

describe("parseAntigravityEventLine", () => {
  it("reads conversation_id from the envelope on init and the payload elsewhere", () => {
    // The two locations differ, which the published docs do not mention. A
    // parser that looks in one place loses the id for the other events.
    const init = parseAntigravityEventLine(GROUND_TRUTH_SESSION[0]!);
    const step = parseAntigravityEventLine(GROUND_TRUTH_SESSION[1]!);
    const result = parseAntigravityEventLine(GROUND_TRUTH_SESSION[4]!);
    NodeAssert.equal(init?.kind, "init");
    NodeAssert.equal(step?.kind, "step_update");
    NodeAssert.equal(result?.kind, "result");
    const id = "10f67314-1420-4910-a94f-a7e3859ba47e";
    NodeAssert.equal(init.kind === "init" ? init.conversationId : null, id);
    NodeAssert.equal(step.kind === "step_update" ? step.conversationId : null, id);
    NodeAssert.equal(result.kind === "result" ? result.conversationId : null, id);
  });

  it("parses the init payload", () => {
    const event = parseAntigravityEventLine(GROUND_TRUTH_SESSION[0]!);
    NodeAssert.equal(event?.kind, "init");
    if (event?.kind !== "init") return;
    NodeAssert.equal(event.model, "gemini-3.8-flash-low");
    NodeAssert.equal(event.cwd, "/tmp/agytest");
    NodeAssert.equal(event.permissionMode, "request-review");
    NodeAssert.equal(event.tools[0], "view_file");
  });

  it("parses usage on the terminal result", () => {
    const event = parseAntigravityEventLine(GROUND_TRUTH_SESSION[4]!);
    NodeAssert.equal(event?.kind, "result");
    if (event?.kind !== "result") return;
    NodeAssert.equal(event.status, "SUCCESS");
    NodeAssert.equal(event.response, "OK\n");
    NodeAssert.equal(event.numTurns, 1);
    NodeAssert.equal(event.usage?.inputTokens, 13713);
    NodeAssert.equal(event.usage?.totalTokens, 13714);
  });

  it("surfaces a framing error as a result event, not a thrown parse failure", () => {
    // The CLI reports bad stdin on stdout as a normal result, contradicting
    // the docs' "diagnostics go to stderr". Observed stderr was empty.
    const event = parseAntigravityEventLine(FRAMING_ERROR_RESULT);
    NodeAssert.equal(event?.kind, "result");
    if (event?.kind !== "result") return;
    NodeAssert.equal(event.status, "ERROR");
    NodeAssert.equal(event.error, 'stream input message is missing the "event" field');
  });

  it("keeps the session alive on an event name this build does not model", () => {
    // agy ships independently of us; a closed union would kill a live turn
    // over an event nothing reads.
    const event = parseAntigravityEventLine('{"event":"telemetry_ping","whatever":1}');
    NodeAssert.equal(event?.kind, "unknown");
    if (event?.kind !== "unknown") return;
    NodeAssert.equal(event.event, "telemetry_ping");
  });

  it("reports a non-JSON line as malformed rather than throwing", () => {
    const event = parseAntigravityEventLine("not json at all");
    NodeAssert.equal(event?.kind, "malformed");
  });

  it("ignores blank lines", () => {
    NodeAssert.equal(parseAntigravityEventLine("   "), null);
    NodeAssert.equal(parseAntigravityEventLine(""), null);
  });

  it("rejects non-finite numbers so they cannot poison token arithmetic", () => {
    // JSON has no NaN literal, but a custom model or proxy can emit a string
    // where a number belongs; that must not become NaN downstream.
    const event = parseAntigravityEventLine(
      '{"event":"step_update","step_update":{"step_index":2,"duration_seconds":"soon","usage":{"input_tokens":"lots"}}}',
    );
    NodeAssert.equal(event?.kind, "step_update");
    if (event?.kind !== "step_update") return;
    NodeAssert.equal(event.durationSeconds, null);
    NodeAssert.equal(event.usage?.inputTokens, 0);
  });

  it("parses tool_info including a tool failure", () => {
    const event = parseAntigravityEventLine(
      '{"event":"step_update","step_update":{"step_index":3,"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"cmd":"ls"},"output":"a\\nb","error":{"type":"NonZeroExit","message":"exit 2"}}}}',
    );
    NodeAssert.equal(event?.kind, "step_update");
    if (event?.kind !== "step_update") return;
    NodeAssert.equal(event.toolName, "run_command");
    NodeAssert.equal(event.toolInfo?.errorType, "NonZeroExit");
    NodeAssert.equal(event.toolInfo?.errorMessage, "exit 2");
  });

  it("parses subagent_info", () => {
    const event = parseAntigravityEventLine(
      '{"event":"step_update","step_update":{"step_index":4,"subagent_info":{"subagents":[{"type_name":"reviewer","role":"review","conversation_id":"c1","log_uri":"file:///l","workspace_uris":["file:///w"]}]}}}',
    );
    NodeAssert.equal(event?.kind, "step_update");
    if (event?.kind !== "step_update") return;
    NodeAssert.equal(event.subagents.length, 1);
    NodeAssert.equal(event.subagents[0]?.typeName, "reviewer");
    NodeAssert.equal(event.subagents[0]?.workspaceUris[0], "file:///w");
  });
});

describe("isAntigravityFailureStatus", () => {
  it("treats only terminal failures as failures", () => {
    for (const status of ["ERROR", "CANCELED", "INTERRUPTED", "INVALID"]) {
      NodeAssert.equal(isAntigravityFailureStatus(status), true, status);
    }
  });

  it("does not fail a turn that is still working", () => {
    // WAITING and RUNNING are progress states. Ending the turn on them would
    // cut off a run that is mid-flight.
    NodeAssert.equal(isAntigravityFailureStatus("WAITING"), false);
    NodeAssert.equal(isAntigravityFailureStatus("RUNNING"), false);
    NodeAssert.equal(isAntigravityFailureStatus("SUCCESS"), false);
  });
});

describe("AntigravityLineFramer", () => {
  it("reassembles an event split across chunk boundaries", () => {
    const framer = new AntigravityLineFramer();
    const line = GROUND_TRUTH_SESSION[0]!;
    const cut = 40;
    NodeAssert.deepEqual(framer.push(line.slice(0, cut)), []);
    const completed = framer.push(`${line.slice(cut)}\n`);
    NodeAssert.equal(completed.length, 1);
    NodeAssert.equal(parseAntigravityEventLine(completed[0]!)?.kind, "init");
  });

  it("emits several events arriving in one chunk", () => {
    const framer = new AntigravityLineFramer();
    const lines = framer.push(`${GROUND_TRUTH_SESSION.join("\n")}\n`);
    NodeAssert.equal(lines.length, GROUND_TRUTH_SESSION.length);
  });

  it("returns an unterminated trailing line on flush", () => {
    // A process killed mid-write leaves the result line unterminated, and that
    // line is usually the one carrying why it died.
    const framer = new AntigravityLineFramer();
    NodeAssert.deepEqual(framer.push('{"event":"result"'), []);
    NodeAssert.deepEqual(framer.flush(), ['{"event":"result"']);
    NodeAssert.deepEqual(framer.flush(), []);
  });

  it("flushes nothing when the stream ended cleanly", () => {
    const framer = new AntigravityLineFramer();
    framer.push('{"event":"init"}\n');
    NodeAssert.deepEqual(framer.flush(), []);
  });
});

describe("AntigravityTurnAccumulator", () => {
  const accumulate = (lines: ReadonlyArray<string>) => {
    const accumulator = new AntigravityTurnAccumulator();
    for (const line of lines) {
      const event = parseAntigravityEventLine(line);
      if (event !== null) accumulator.observe(event);
    }
    return accumulator;
  };

  it("keeps the text carried on the DONE frame", () => {
    // The regression this guards: ground truth is ACTIVE "OK" then DONE "\n".
    // Treating DONE as a pure terminator silently truncates the tail of every
    // message, and an assertion that only checked `startsWith("OK")` passes.
    const accumulator = accumulate(GROUND_TRUTH_SESSION);
    NodeAssert.equal(accumulator.assistantText(), "OK\n");
  });

  it("agrees with the CLI's own result.response", () => {
    // The strongest available check: our fold must reproduce exactly what the
    // CLI independently reports as the final answer.
    const accumulator = accumulate(GROUND_TRUTH_SESSION);
    const result = parseAntigravityEventLine(GROUND_TRUTH_SESSION[4]!);
    NodeAssert.equal(result?.kind, "result");
    if (result?.kind !== "result") return;
    NodeAssert.equal(accumulator.assistantText(), result.response);
  });

  it("excludes user_input and tool steps from assistant prose", () => {
    const accumulator = accumulate([
      ...GROUND_TRUTH_SESSION,
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","text_delta":"IGNORED"}}',
    ]);
    NodeAssert.equal(accumulator.assistantText(), "OK\n");
    NodeAssert.equal(accumulator.snapshot().length, 3);
  });

  it("orders steps by index, not by arrival", () => {
    const accumulator = accumulate([
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"agent_response","text_delta":"second"}}',
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"first "}}',
    ]);
    NodeAssert.equal(accumulator.assistantText(), "first second");
  });

  it("does not un-finish a step that already reported DONE", () => {
    const accumulator = accumulate([
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"a"}}',
      '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"b"}}',
    ]);
    NodeAssert.equal(accumulator.snapshot()[0]?.done, true);
    NodeAssert.equal(accumulator.assistantText(), "ab");
  });

  it("drops an indexless frame instead of merging it into another step", () => {
    const accumulator = accumulate([
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"kept"}}',
      '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"orphan"}}',
    ]);
    NodeAssert.equal(accumulator.assistantText(), "kept");
  });

  it("learns the conversation id from init before any step arrives", () => {
    // Resume depends on this: the id must be known even if the turn dies
    // before producing a single step.
    const accumulator = accumulate([GROUND_TRUTH_SESSION[0]!]);
    NodeAssert.equal(accumulator.currentConversationId(), "10f67314-1420-4910-a94f-a7e3859ba47e");
  });

  it("upgrades a tool step from its partial ACTIVE frame to the completed DONE frame", () => {
    // Real capture: the ACTIVE frame carries only {name, parameters}; `output`
    // appears solely on DONE. Folding must end up with the completed record,
    // so a tool result is never rendered as an empty output.
    const accumulator = accumulate(GROUND_TRUTH_TOOL_STEP);
    const step = accumulator.snapshot()[0];
    NodeAssert.equal(step?.stepType, "tool");
    NodeAssert.equal(step?.toolName, "run_command");
    NodeAssert.equal(step?.done, true);
    NodeAssert.equal(step?.toolInfo?.output, "cat: sample.txt: No such file or directory\n");
    NodeAssert.deepEqual(step?.toolInfo?.parameters, { CommandLine: "cat sample.txt" });
    NodeAssert.equal(step?.durationSeconds, 0.16127);
  });

  it("keeps a completed tool_info when a later frame omits it", () => {
    // Guards the fold direction: falling back to the previous record must not
    // let a sparse trailing frame erase an output already delivered.
    const accumulator = accumulate([
      ...GROUND_TRUTH_TOOL_STEP,
      '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool"}}',
    ]);
    NodeAssert.equal(
      accumulator.snapshot()[0]?.toolInfo?.output,
      "cat: sample.txt: No such file or directory\n",
    );
  });

  it("retains usage from the frame that reported it", () => {
    const accumulator = accumulate(GROUND_TRUTH_SESSION);
    const responseStep = accumulator.snapshot().find((step) => step.stepIndex === 1);
    NodeAssert.equal(responseStep?.usage?.totalTokens, 13714);
    NodeAssert.equal(responseStep?.done, true);
  });
});

describe("buildAntigravityStreamArgs", () => {
  it("ends with an attached, genuinely empty -p=", () => {
    // Two verified traps: `-p` consumes the NEXT token as its prompt, so a
    // detached or non-final placement makes the CLI swallow a flag (exit 2);
    // and the value must be an empty string, because `-p=""` only works when
    // a shell strips the quotes. Under `spawn` the CLI sees a literal `""`
    // prompt and exits 2. Verified against agy v1.1.24.
    const args = buildAntigravityStreamArgs({});
    NodeAssert.equal(args[args.length - 1], "-p=");
    NodeAssert.equal(
      args.some((arg) => arg.includes('"')),
      false,
    );
    NodeAssert.deepEqual(args.slice(0, 4), [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
  });

  it("keeps every optional flag ahead of the prompt flag", () => {
    const args = buildAntigravityStreamArgs({
      model: "gemini-3.8-flash-low",
      effort: "low",
      agent: "reviewer",
      conversationId: "abc",
      skipPermissions: true,
      addDirs: ["/w/a", "/w/b"],
    });
    NodeAssert.equal(args[args.length - 1], "-p=");
    NodeAssert.equal(args.indexOf("--model") < args.length - 1, true);
    NodeAssert.equal(args.includes("--dangerously-skip-permissions"), true);
    NodeAssert.equal(args.filter((arg) => arg === "--add-dir").length, 2);
    NodeAssert.equal(args[args.indexOf("--conversation") + 1], "abc");
  });

  it("omits flags that are empty rather than passing a blank value", () => {
    // `--model ""` is not the same as no --model: an unknown model exits 1,
    // and headless mode deliberately refuses to fall back.
    const args = buildAntigravityStreamArgs({ model: "", effort: undefined });
    NodeAssert.equal(args.includes("--model"), false);
    NodeAssert.equal(args.includes("--effort"), false);
  });
});

describe("encodeAntigravityUserMessage", () => {
  it("emits one line the CLI accepts", () => {
    const line = encodeAntigravityUserMessage("hello");
    NodeAssert.equal(line.includes("\n"), false);
    NodeAssert.deepEqual(JSON.parse(line), {
      event: "user",
      message: { content: "hello" },
    });
  });

  it("escapes newlines so a multi-line prompt stays one NDJSON record", () => {
    const line = encodeAntigravityUserMessage("line one\nline two");
    NodeAssert.equal(line.split("\n").length, 1);
    NodeAssert.equal(JSON.parse(line).message.content, "line one\nline two");
  });
});

describe("parseAntigravityModelsOutput", () => {
  /** Captured verbatim from `agy models` on v1.1.24. */
  const REAL_MODELS_OUTPUT = [
    "Fetching available models...",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
    "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n");

  it("parses the real model list", () => {
    const models = parseAntigravityModelsOutput(REAL_MODELS_OUTPUT);
    NodeAssert.equal(models.length, 8);
    NodeAssert.deepEqual(models[0], {
      slug: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash (High)",
    });
    NodeAssert.equal(models.at(-1)?.slug, "gpt-oss-120b-medium");
  });

  it("drops the human status line without assuming it is first", () => {
    // Requiring a tab is what makes this robust: a positional "skip line 1"
    // rule silently eats a real model the day the banner moves or vanishes.
    const reordered = [
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "Fetching available models...",
    ].join("\n");
    const models = parseAntigravityModelsOutput(reordered);
    NodeAssert.equal(models.length, 1);
    NodeAssert.equal(models[0]?.slug, "gemini-3.8-flash-low");
  });

  it("keeps the effort suffix intact", () => {
    // The suffix is part of the slug the CLI validates; normalising it away
    // would produce a model name that exits 1 on use.
    const models = parseAntigravityModelsOutput("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)");
    NodeAssert.equal(models[0]?.slug, "gemini-3.8-flash-low");
  });

  it("ignores blank lines and de-duplicates repeated slugs", () => {
    const models = parseAntigravityModelsOutput(
      ["a\tA", "", "   ", "a\tA duplicate", "b\tB"].join("\n"),
    );
    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["a", "b"],
    );
    NodeAssert.equal(models[0]?.label, "A");
  });

  it("falls back to the slug when a label is missing", () => {
    const models = parseAntigravityModelsOutput("solo\t");
    NodeAssert.deepEqual(models, [{ slug: "solo", label: "solo" }]);
  });

  it("returns nothing for output with no tabbed rows", () => {
    NodeAssert.deepEqual(parseAntigravityModelsOutput("not authenticated\n"), []);
  });
});

describe("parseAntigravityModelsOutput on Windows line endings", () => {
  it("parses CRLF output", () => {
    // The Windows box runs the same server, and a stray \r would end up
    // inside every model label.
    const models = parseAntigravityModelsOutput(
      "Fetching available models...\r\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\r\n",
    );
    NodeAssert.deepEqual(models, [{ slug: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }]);
  });
});
