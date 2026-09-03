import { describe, expect, it } from "vite-plus/test";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  canReferenceLocalComposerFiles,
  classifyComposerFileIntake,
  COMPOSER_MAX_PROMPT_CHARS,
  composerPromptLengthState,
  isComposerSubmitBlocked,
  isEnabledComposerSubmitButton,
  isCollapsedCursorAdjacentToInlineToken,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
  shouldSubmitComposerOnEnter,
} from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("shouldSubmitComposerOnEnter", () => {
  it("submits plain Enter on desktop", () => {
    expect(shouldSubmitComposerOnEnter({ isMobileViewport: false, shiftKey: false })).toBe(true);
  });

  it("inserts a newline for plain Enter on mobile", () => {
    expect(shouldSubmitComposerOnEnter({ isMobileViewport: true, shiftKey: false })).toBe(false);
  });

  it("inserts a newline for Shift+Enter", () => {
    expect(shouldSubmitComposerOnEnter({ isMobileViewport: false, shiftKey: true })).toBe(false);
  });
});

describe("isEnabledComposerSubmitButton", () => {
  it("only permits Enter submission through an enabled rendered submit action", () => {
    expect(isEnabledComposerSubmitButton(null)).toBe(false);
    expect(isEnabledComposerSubmitButton({ disabled: true })).toBe(false);
    expect(isEnabledComposerSubmitButton({ disabled: false })).toBe(true);
  });
});

describe("composerPromptLengthState", () => {
  it("counts the trimmed length the server validates, not code points", () => {
    // The server trims first, so surrounding whitespace must not count.
    expect(composerPromptLengthState("  hi  ", 10).length).toBe(2);
    // An emoji is two UTF-16 code units; the server's isMaxLength counts those,
    // so counting code points here would under-report and let a send fail.
    expect(composerPromptLengthState("\u{1F600}", 10).length).toBe(2);
  });

  it("reports how far over the limit a long paste is", () => {
    const state = composerPromptLengthState("x".repeat(120_050), 120_000);
    expect(state.tooLong).toBe(true);
    expect(state.overBy).toBe(50);
    expect(state.nearLimit).toBe(true);
  });

  it("warns on approach before the limit is broken", () => {
    const approaching = composerPromptLengthState("x".repeat(109_000), 120_000);
    expect(approaching.tooLong).toBe(false);
    expect(approaching.nearLimit).toBe(true);
    const short = composerPromptLengthState("x".repeat(10), 120_000);
    expect(short.nearLimit).toBe(false);
    expect(short.overBy).toBe(0);
  });

  it("defaults to the provider limit the server enforces", () => {
    expect(COMPOSER_MAX_PROMPT_CHARS).toBe(120_000);
    expect(composerPromptLengthState("x").max).toBe(120_000);
  });
});

describe("isComposerSubmitBlocked", () => {
  const ready = {
    noProviderAvailable: false,
    isSendDisabled: false,
    pushToTalkStatus: null,
  } as const;

  it("permits submission only when nothing is pending", () => {
    expect(isComposerSubmitBlocked(ready)).toBe(false);
    expect(isComposerSubmitBlocked({ ...ready, noProviderAvailable: true })).toBe(true);
    expect(isComposerSubmitBlocked({ ...ready, promptTooLong: true })).toBe(true);
    expect(isComposerSubmitBlocked({ ...ready, promptTooLong: false })).toBe(false);
    expect(isComposerSubmitBlocked({ ...ready, isSendDisabled: true })).toBe(true);
  });

  it("blocks submission through every voice transcription phase", () => {
    // Enter during transcription previously submitted a half-written draft,
    // landing it in the middle of a running turn's output.
    for (const pushToTalkStatus of ["recording", "loading", "transcribing"] as const) {
      expect(isComposerSubmitBlocked({ ...ready, pushToTalkStatus })).toBe(true);
    }
  });
});

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects $skill trigger at cursor", () => {
    const text = "Use $gh-fi";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("maps collapsed quoted mention cursor to expanded text cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("maps collapsed markdown file links to their expanded source offsets", () => {
    const text = "what's in [AGENTS.md](AGENTS.md) please";
    const collapsedCursorAfterMention = "what's in ".length + 2;
    const expandedCursorAfterMention = "what's in [AGENTS.md](AGENTS.md) ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });

  it("maps collapsed skill cursor to expanded text cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterSkill)).toBe(
      expandedCursorAfterSkill,
    );
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded quoted mention cursor back to collapsed cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded markdown file link cursors back to collapsed offsets", () => {
    const text = "what's in [AGENTS.md](AGENTS.md) please";
    const collapsedCursorAfterMention = "what's in ".length + 2;
    const expandedCursorAfterMention = "what's in [AGENTS.md](AGENTS.md) ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps package-like text expanded when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then @src/index.ts ".length);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("collapses only genuine mentions when package-like text exists earlier", () => {
    const text = "install @scope/pkg then @README.md ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("install @scope/pkg then ".length + 1 + " ".length);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("maps expanded skill cursor back to collapsed cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats terminal pills as inline tokens for adjacency checks", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats skill pills as inline tokens for adjacency checks", () => {
    const text = "run $review-follow-up next";
    const tokenStart = "run ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});

describe("classifyComposerFileIntake", () => {
  const image = (name: string) => new File(["x"], name, { type: "image/png" });
  const video = (name: string) => new File(["x"], name, { type: "video/mp4" });

  it("uploads images and attaches everything else as a path reference", () => {
    const intake = classifyComposerFileIntake([image("shot.png"), video("clip.mp4")], {
      resolvePath: (file) => `/movies/${file.name}`,
      imageSlotsUsed: 0,
      maxImages: 10,
    });
    expect(intake.imageFiles.map((file) => file.name)).toEqual(["shot.png"]);
    expect(intake.referencedPaths).toEqual(["/movies/clip.mp4"]);
    expect(intake.error).toBeNull();
  });

  it("errors on non-images only where no OS path is resolvable", () => {
    const intake = classifyComposerFileIntake([video("clip.mp4")], {
      resolvePath: () => null,
      imageSlotsUsed: 0,
      maxImages: 10,
    });
    expect(intake.referencedPaths).toEqual([]);
    expect(intake.error).toContain("clip.mp4");
    expect(intake.error).toContain("desktop app");
    expect(intake.error).toContain("same computer");
  });

  it("still enforces the image cap, counting already-attached images", () => {
    const intake = classifyComposerFileIntake([image("a.png"), image("b.png")], {
      resolvePath: () => null,
      imageSlotsUsed: 9,
      maxImages: 10,
    });
    expect(intake.imageFiles.map((file) => file.name)).toEqual(["a.png"]);
    expect(intake.error).toContain("up to 10 images");
  });
});

describe("canReferenceLocalComposerFiles", () => {
  it("allows only the same-machine desktop primary environment", () => {
    expect(
      canReferenceLocalComposerFiles({
        hasDesktopPathResolver: true,
        environmentTargetKind: "PrimaryConnectionTarget",
      }),
    ).toBe(true);
    expect(
      canReferenceLocalComposerFiles({
        hasDesktopPathResolver: false,
        environmentTargetKind: "PrimaryConnectionTarget",
      }),
    ).toBe(false);
    expect(
      canReferenceLocalComposerFiles({
        hasDesktopPathResolver: true,
        environmentTargetKind: "SshConnectionTarget",
      }),
    ).toBe(false);
    expect(
      canReferenceLocalComposerFiles({
        hasDesktopPathResolver: true,
        environmentTargetKind: "BearerConnectionTarget",
      }),
    ).toBe(false);
  });
});
