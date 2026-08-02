import { describe, expect, it } from "vite-plus/test";

import { parseStandaloneComposerSlashCommand } from "./composer-logic";

/**
 * `/refresh-plan` must perform its action without sending anything to the chat.
 *
 * The composer's submit path only intercepts text that
 * `parseStandaloneComposerSlashCommand` recognises; anything it returns null for
 * is sent as an ordinary message. So a null here is the exact failure the
 * feature must not have, and it would be invisible in a type check.
 */
describe("/refresh-plan is intercepted rather than sent", () => {
  it("is recognised as a standalone command", () => {
    expect(parseStandaloneComposerSlashCommand("/refresh-plan")).toBe("refresh-plan");
  });

  it("tolerates the whitespace and casing people actually type", () => {
    expect(parseStandaloneComposerSlashCommand("  /refresh-plan  ")).toBe("refresh-plan");
    expect(parseStandaloneComposerSlashCommand("/Refresh-Plan")).toBe("refresh-plan");
  });

  it("is not mistaken for the shorter /plan command", () => {
    // Both names end in "plan", so a careless alternation would switch the
    // thread into plan mode instead of refreshing the task list.
    expect(parseStandaloneComposerSlashCommand("/refresh-plan")).not.toBe("plan");
    expect(parseStandaloneComposerSlashCommand("/plan")).toBe("plan");
  });

  it("still leaves ordinary prose alone", () => {
    // Only a bare command is intercepted — a sentence mentioning it is a message.
    expect(parseStandaloneComposerSlashCommand("can you /refresh-plan for me")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/refresh-plan now please")).toBeNull();
  });
});
