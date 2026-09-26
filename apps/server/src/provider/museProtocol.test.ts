import { describe, expect, it } from "vite-plus/test";

import {
  boundMuseText,
  classifyMuseToolItemType,
  encodeMuseFrame,
  isMuseCommandId,
  museAuthFilePath,
  museCommandId,
  museItemFailed,
  museItemSettled,
  museModelsFromCatalog,
  museReasoningEffort,
  museCompletionCost,
  museModelCostFrom,
  MUSE_EFFORT_OPTIONS,
  museReasoningText,
  museServeArgs,
  museToolDetail,
  museToolTitle,
  parseMuseLine,
  parseMuseVersion,
  splitMuseLines,
  MUSE_CLIENT_NAME,
} from "./museProtocol.ts";

describe("museCommandId", () => {
  it("mints a UUIDv7, because MSP rejects the v4 the platform generates", () => {
    const id = museCommandId(1_700_000_000_000);
    expect(isMuseCommandId(id)).toBe(true);
    expect(id[14]).toBe("7");
  });

  it("orders by creation time so idempotency handles sort", () => {
    const earlier = museCommandId(1_700_000_000_000);
    const later = museCommandId(1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  it("rejects a v4 uuid", () => {
    expect(isMuseCommandId("f81d4fae-7dec-41d0-a765-00a0c91e6bf6")).toBe(false);
  });
});

describe("MUSE_CLIENT_NAME", () => {
  it("satisfies the host's machine-identifier rule", () => {
    // The product's own name has a hyphen and is rejected with invalidParams.
    expect(MUSE_CLIENT_NAME).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("museServeArgs", () => {
  it("never passes --no-session-log, which would serve no view plane", () => {
    // A memory-only host accepts turns and streams nothing back: no item
    // events, no turn/completed, and the work log stays empty.
    expect(museServeArgs()).not.toContain("--no-session-log");
    expect(museServeArgs()[0]).toBe("serve");
  });
});

describe("parseMuseLine", () => {
  it("reads a result", () => {
    const frame = parseMuseLine('{"jsonrpc":"2.0","id":4,"result":{"turnId":"t1"}}');
    expect(frame).toEqual({ kind: "result", id: 4, result: { turnId: "t1" } });
  });

  it("carries the error kind so callers can branch on notInitialized", () => {
    const frame = parseMuseLine(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"Not initialized","data":{"kind":"notInitialized"}}}',
    );
    expect(frame).toMatchObject({ kind: "error", id: 2, errorKind: "notInitialized" });
  });

  it("reads a notification", () => {
    const frame = parseMuseLine(
      '{"jsonrpc":"2.0","method":"turn/started","params":{"turnId":"t"}}',
    );
    expect(frame).toEqual({
      kind: "notification",
      method: "turn/started",
      params: { turnId: "t" },
    });
  });

  it("reports a non-JSON line instead of throwing", () => {
    expect(parseMuseLine("muse: launcher warning")).toEqual({
      kind: "unparseable",
      line: "muse: launcher warning",
    });
  });

  it("ignores blank keepalive lines", () => {
    expect(parseMuseLine("   ")).toBeNull();
  });
});

describe("splitMuseLines", () => {
  it("keeps a frame split across chunk boundaries", () => {
    const first = splitMuseLines('{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    const second = splitMuseLines(`${first.rest}2}\n`);
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });
});

describe("encodeMuseFrame", () => {
  it("terminates every frame with a newline", () => {
    expect(encodeMuseFrame({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    );
  });

  it("preserves numeric and string ids when acknowledging a server request", () => {
    for (const id of [0, "approval-1"]) {
      const frame = encodeMuseFrame({ jsonrpc: "2.0", id, result: {} });
      expect(frame.split("\n")).toHaveLength(2);
      expect(JSON.parse(frame)).toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });

  it("escapes error details so an unsupported request stays in one wire frame", () => {
    const error = {
      code: -32601,
      message: 'method not found: unknown/"request"\nnext',
      data: { kind: "methodNotFound" },
    };
    const frame = encodeMuseFrame({ jsonrpc: "2.0", id: "request-1", error });
    expect(frame.split("\n")).toHaveLength(2);
    expect(JSON.parse(frame)).toEqual({ jsonrpc: "2.0", id: "request-1", error });
  });
});

describe("museReasoningEffort", () => {
  it("maps max to Muse's max rather than the tier above it", () => {
    // ultra exists, but taking it would make "max" mean something different
    // here than it does for every other provider.
    expect(museReasoningEffort("max")).toBe("max");
    expect(museReasoningEffort("medium")).toBe("medium");
  });

  it("passes xhigh through, since both vocabularies spell it the same", () => {
    // Dropped, an explicit "Extra High" became the host's own default and the
    // setting the person chose did nothing at all.
    expect(museReasoningEffort("xhigh")).toBe("xhigh");
  });

  it("leaves an unknown effort to the host default", () => {
    expect(museReasoningEffort(undefined)).toBeUndefined();
    expect(museReasoningEffort("nimbus")).toBeUndefined();
  });

  /**
   * The picker may only offer tiers this mapping can express. An option that
   * falls through to `undefined` looks like a choice and behaves like the
   * default, which is the failure mode the whole closed vocabulary exists to
   * prevent.
   */
  it("offers no tier it cannot actually send", () => {
    for (const option of MUSE_EFFORT_OPTIONS) {
      expect(museReasoningEffort(option.value), option.value).toBe(option.value);
    }
    // Exactly one default, so the picker opens on the tier an unset session
    // would really run.
    expect(MUSE_EFFORT_OPTIONS.filter((option) => "isDefault" in option)).toHaveLength(1);
  });
});

describe("classifyMuseToolItemType", () => {
  it("classifies the tools Muse actually names", () => {
    expect(classifyMuseToolItemType("shell")).toBe("command_execution");
    expect(classifyMuseToolItemType("apply_patch")).toBe("file_change");
    expect(classifyMuseToolItemType("web_search")).toBe("web_search");
    expect(classifyMuseToolItemType("mcp__t3-code__preview_open")).toBe("mcp_tool_call");
  });

  it("does not claim a file changed for an unknown tool", () => {
    expect(classifyMuseToolItemType("quantum_frobnicate")).toBe("dynamic_tool_call");
  });

  it("labels each lifecycle row", () => {
    expect(museToolTitle("command_execution")).toBe("Command run");
    expect(museToolTitle("dynamic_tool_call")).toBe("Tool");
  });
});

describe("museReasoningText", () => {
  it("joins a streamed summary into the model's own paragraphs", () => {
    const text = museReasoningText({
      itemId: "i",
      kind: "reasoning",
      status: "inProgress",
      revision: 3,
      summary: ["First I will read the file.", "Then I will patch it."],
    });
    expect(text).toBe("First I will read the file.\n\nThen I will patch it.");
  });

  it("falls back to text when there is no summary", () => {
    expect(
      museReasoningText({
        itemId: "i",
        kind: "reasoning",
        status: "completed",
        revision: 1,
        text: " thinking ",
      }),
    ).toBe("thinking");
  });

  it("keeps a long thought whole rather than previewing it", () => {
    const long = "A sentence that keeps going. ".repeat(100).trim();
    expect(
      museReasoningText({
        itemId: "i",
        kind: "reasoning",
        status: "completed",
        revision: 1,
        text: long,
      }),
    ).toBe(long);
  });
});

describe("museToolDetail", () => {
  it("prefers the command text", () => {
    expect(
      museToolDetail({
        itemId: "i",
        kind: "toolCall",
        status: "inProgress",
        revision: 1,
        tool: "shell",
        commandText: "git status",
        args: '{"cmd":"git status"}',
      }),
    ).toBe("git status");
  });

  it("falls back to arguments, then to nothing", () => {
    expect(
      museToolDetail({
        itemId: "i",
        kind: "toolCall",
        status: "inProgress",
        revision: 1,
        args: "{}",
      }),
    ).toBe("{}");
    expect(
      museToolDetail({ itemId: "i", kind: "toolCall", status: "inProgress", revision: 1 }),
    ).toBeUndefined();
  });
});

describe("museItemFailed / museItemSettled", () => {
  it("treats a cancelled item as settled but not failed", () => {
    expect(museItemSettled("cancelled")).toBe(true);
    expect(museItemFailed("cancelled")).toBe(false);
    expect(museItemFailed("timedOut")).toBe(true);
    expect(museItemSettled("inProgress")).toBe(false);
  });
});

describe("museModelsFromCatalog", () => {
  it("reads the host's own field names", () => {
    // Verified against a live signed-in catalog: `displayLabel` and
    // `contextLimit`, not `displayName`/`contextWindow`.
    expect(
      museModelsFromCatalog({
        providerId: "meta",
        source: "providerCatalog",
        models: [
          {
            modelId: "muse-spark-1.3",
            displayLabel: "muse-spark-1.3",
            contextLimit: 1_007_997,
            isActive: true,
            isDefault: false,
          },
        ],
      }),
    ).toEqual([
      {
        modelId: "muse-spark-1.3",
        displayName: "muse-spark-1.3",
        contextWindow: 1_007_997,
        isSessionSelected: true,
        isDefault: false,
      },
    ]);
  });

  it("keeps every model when the host marks none as the session's selection", () => {
    // Live `model/list` with no `sessionId` - which is how the probe calls it
    // - returns `isActive: false` on every row. The MSP schema says so
    // outright: it "marks the session's effective model when `sessionId` was
    // supplied. May be false for every row." Reading it as entitlement is
    // what emptied the picker on a signed-in account whose CLI was happily
    // running `muse-spark-1.3-contributor`.
    const models = museModelsFromCatalog({
      models: [
        { modelId: "muse-spark-1.3", isActive: false, isDefault: false },
        { modelId: "muse-spark-1.3-contributor", isActive: false, isDefault: true },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models.every((model) => !model.isSessionSelected)).toBe(true);
    expect(models[1]?.isDefault).toBe(true);
  });

  it("reports a missing isActive as not the session's selection", () => {
    // Absent means "this response says nothing about the selection", which is
    // false, not true. Nothing filters on it, so this cannot hide a model.
    const [model] = museModelsFromCatalog({ models: [{ modelId: "muse-spark-1.2" }] });
    expect(model?.isSessionSelected).toBe(false);
    expect(model?.modelId).toBe("muse-spark-1.2");
  });

  it("stays empty when the account is signed out instead of inventing ids", () => {
    // A signed-out host answers {source:"bundledCatalog", models:[]}. Filling
    // that in with guessed slugs is the nimbus_quill mistake.
    expect(
      museModelsFromCatalog({ providerId: "meta", source: "bundledCatalog", models: [] }),
    ).toEqual([]);
    expect(museModelsFromCatalog(undefined)).toEqual([]);
  });

  it("drops a malformed entry rather than passing a blank id through", () => {
    expect(
      museModelsFromCatalog({ models: [{ modelId: "  " }, { displayName: "no id" }] }),
    ).toEqual([]);
  });
});

describe("museAuthFilePath", () => {
  it("points at the credential file, not the lock beside it", () => {
    // `.auth.json.lock` exists from the CLI's first run and says nothing about
    // whether anyone signed in; reading it reports every account signed out.
    const path = museAuthFilePath({ HOME: "/home/dev" } as NodeJS.ProcessEnv);
    expect(path).toBe("/home/dev/.config/muse/auth.json");
    expect(path).not.toContain(".auth.json");
  });

  it("honours XDG_CONFIG_HOME", () => {
    expect(
      museAuthFilePath({ HOME: "/home/dev", XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv),
    ).toBe("/cfg/muse/auth.json");
  });
});

describe("parseMuseVersion", () => {
  it("reads the binary's own banner", () => {
    expect(parseMuseVersion("Muse Code 1.1.1 (1.1.1-R2514.1)")).toBe("1.1.1");
  });

  it("returns null when there is no version at all", () => {
    expect(parseMuseVersion("command not found")).toBeNull();
  });
});

describe("boundMuseText", () => {
  it("marks a truncation it had to make", () => {
    expect(boundMuseText("abcdef", 4)).toBe("abc…");
    expect(boundMuseText("abc", 4)).toBe("abc");
  });
});

describe("museCompletionCost", () => {
  const cost = { input: "1.00", output: "5.00", cachedInput: "0.10", currency: "USD" };

  it("prices the uncached prompt, the cached prompt and the output separately", () => {
    // 1,200 uncached at $1/M + 96,000 cached at $0.10/M + 800 out at $5/M.
    expect(
      museCompletionCost({ cost, promptTokens: 97_200, cachedTokens: 96_000, outputTokens: 800 }),
    ).toBeCloseTo(0.0012 + 0.0096 + 0.004, 10);
  });

  it("charges cached tokens at the input rate when the catalog has no cached price", () => {
    const { cachedInput: _cached, ...noCached } = cost;
    expect(
      museCompletionCost({
        cost: noCached,
        promptTokens: 1_000_000,
        cachedTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(1, 10);
  });

  it("never lets a cache count larger than the prompt go negative", () => {
    expect(
      museCompletionCost({ cost, promptTokens: 100, cachedTokens: 500, outputTokens: 0 }),
    ).toBeCloseTo((100 * 0.1) / 1_000_000, 12);
  });

  it("reads a catalog cost block and refuses a half-priced one", () => {
    expect(museModelCostFrom({ input: "1.5", output: "6", currency: "USD" })).toEqual({
      input: "1.5",
      output: "6",
      currency: "USD",
    });
    expect(museModelCostFrom({ input: "1.5" })).toBeUndefined();
    expect(museModelCostFrom(null)).toBeUndefined();
  });
});
