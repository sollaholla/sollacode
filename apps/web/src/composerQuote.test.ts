import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildQuotedPrompt,
  composerQuoteTargetKey,
  formatQuoteBlock,
  useComposerQuoteStore,
} from "./composerQuote";

describe("formatQuoteBlock", () => {
  it("prefixes every line of the selection", () => {
    expect(formatQuoteBlock("first\nsecond")).toBe("> first\n> second");
  });

  it("keeps interior blank lines as bare markers", () => {
    // `> ` with a trailing space renders as a hard break in some parsers.
    expect(formatQuoteBlock("first\n\nsecond")).toBe("> first\n>\n> second");
  });

  it("normalises CRLF so no stray carriage returns survive", () => {
    expect(formatQuoteBlock("first\r\nsecond")).toBe("> first\n> second");
  });

  it("returns nothing for an empty or whitespace-only selection", () => {
    expect(formatQuoteBlock("")).toBe("");
    expect(formatQuoteBlock("   \n  ")).toBe("");
  });
});

describe("buildQuotedPrompt", () => {
  it("places the cursor on a blank line beneath the quote", () => {
    const result = buildQuotedPrompt({ prompt: "", selection: "hello" });
    expect(result.prompt).toBe("> hello\n\n");
    // The cursor sits at the very end, ready to type a reply.
    expect(result.cursor).toBe(result.prompt.length);
  });

  it("separates an existing draft from the quote with a blank line", () => {
    const result = buildQuotedPrompt({ prompt: "my note", selection: "quoted" });
    expect(result.prompt).toBe("my note\n\n> quoted\n\n");
  });

  it("does not accumulate blank lines when the draft already ends in whitespace", () => {
    const result = buildQuotedPrompt({ prompt: "my note\n\n", selection: "quoted" });
    expect(result.prompt).toBe("my note\n\n> quoted\n\n");
  });

  it("leaves the draft untouched when the selection is empty", () => {
    const result = buildQuotedPrompt({ prompt: "keep me", selection: "  " });
    expect(result.prompt).toBe("keep me");
    expect(result.cursor).toBe("keep me".length);
  });
});

describe("composerQuoteTargetKey", () => {
  it("keeps drafts and threads on separate keys", () => {
    expect(composerQuoteTargetKey("draft-1")).toBe("draft:draft-1");
    expect(
      composerQuoteTargetKey({
        environmentId: EnvironmentId.make("environment-local"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toBe("thread:environment-local:thread-1");
  });
});

describe("useComposerQuoteStore", () => {
  it("hands the pending selection over exactly once to the matching composer", () => {
    const store = useComposerQuoteStore.getState();
    store.requestQuote("some text", "thread:side");
    expect(useComposerQuoteStore.getState().takeQuote({ targetKey: "thread:main" })).toBeNull();
    expect(useComposerQuoteStore.getState().takeQuote({ targetKey: "thread:side" })).toBe(
      "some text",
    );
    // Cleared on read, so a composer remount cannot duplicate the quote.
    expect(useComposerQuoteStore.getState().takeQuote({ targetKey: "thread:side" })).toBeNull();
  });

  it("lets only the main composer claim a quote with no pane target", () => {
    useComposerQuoteStore.getState().requestQuote("untargeted");
    expect(useComposerQuoteStore.getState().takeQuote({ targetKey: "thread:side" })).toBeNull();
    expect(
      useComposerQuoteStore.getState().takeQuote({
        targetKey: "thread:main",
        acceptUntargeted: true,
      }),
    ).toBe("untargeted");
  });

  it("ignores a blank selection", () => {
    useComposerQuoteStore.getState().requestQuote("   ");
    expect(
      useComposerQuoteStore.getState().takeQuote({
        targetKey: "thread:main",
        acceptUntargeted: true,
      }),
    ).toBeNull();
  });
});
