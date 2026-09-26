import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  CONTEXT_RECOVERY_TOOL_NAME,
  contextRecoveryReminder,
  contextRecoveryReminderBlock,
  withContextRecoveryReminder,
  historyResetReminderBlock,
} from "./contextRecovery.ts";

describe("contextRecovery", () => {
  it("names the query tool in every reason", () => {
    for (const reason of ["compaction", "provider-handoff"] as const) {
      NodeAssert.ok(
        contextRecoveryReminder(reason).includes(CONTEXT_RECOVERY_TOOL_NAME),
        `${reason} reminder must name the tool`,
      );
    }
  });

  it("distinguishes compaction from a provider handoff", () => {
    const compaction = contextRecoveryReminder("compaction");
    const handoff = contextRecoveryReminder("provider-handoff");
    NodeAssert.notEqual(compaction, handoff);
    NodeAssert.ok(compaction.includes("compacted"));
    NodeAssert.ok(handoff.includes("handed"));
  });

  it("tells a handed-over model to read history before calling anything done", () => {
    // The soft compaction phrasing let incoming models trust the digest and
    // drop outstanding requests (reported 2026-09-02). A handoff holds no
    // other context, so its closing line is an instruction, and it says which
    // way to resolve doubt about work the excerpt never showed.
    const handoff = contextRecoveryReminder("provider-handoff");
    NodeAssert.ok(handoff.includes("Read that history before"));
    NodeAssert.ok(handoff.includes("still owed unless the record shows it delivered"));
    NodeAssert.ok(!handoff.includes("Prefer querying it over guessing"));

    // Compaction keeps the capability phrasing: it still has its own summary,
    // and most of its turns need no lookup at all.
    const compaction = contextRecoveryReminder("compaction");
    NodeAssert.ok(compaction.includes("Prefer querying it over guessing"));
    NodeAssert.ok(!compaction.includes("Read that history before"));
  });

  it("points a runtime without the history tool at the workspace", () => {
    // Live 2026-09-10: Deep Code received this reminder with no t3-code MCP
    // server mounted. Naming the tool read as a broken integration, so the
    // model answered "I am blocked" and asked the user to re-supply context
    // the digest already carried.
    const handoff = contextRecoveryReminder("provider-handoff", {
      threadHistoryToolAvailable: false,
    });
    NodeAssert.ok(!handoff.includes(CONTEXT_RECOVERY_TOOL_NAME));
    NodeAssert.ok(handoff.includes("workspace is the record you can inspect"));
    NodeAssert.ok(handoff.includes("Do not ask the user to paste, repeat, or summarize"));
    NodeAssert.ok(handoff.includes("do not report yourself blocked"));
    NodeAssert.ok(handoff.includes("still owed unless that evidence shows it delivered"));
    // The tool-directed closing cannot be followed here, so it must not appear.
    NodeAssert.ok(!handoff.includes("Read that history before"));
  });

  it("keeps the history-tool instruction when the runtime mounts it", () => {
    NodeAssert.equal(
      contextRecoveryReminder("provider-handoff", { threadHistoryToolAvailable: true }),
      contextRecoveryReminder("provider-handoff"),
    );
  });

  it("wraps the reminder as a system reminder block", () => {
    const block = contextRecoveryReminderBlock("compaction");
    NodeAssert.ok(block.startsWith("<system-reminder>"));
    NodeAssert.ok(block.endsWith("</system-reminder>"));
    NodeAssert.ok(block.includes(CONTEXT_RECOVERY_TOOL_NAME));
  });

  it("leaves the prompt untouched when nothing is pending", () => {
    NodeAssert.equal(withContextRecoveryReminder("do the thing", undefined), "do the thing");
  });

  it("prepends the reminder ahead of the prompt", () => {
    const result = withContextRecoveryReminder("do the thing", "compaction");
    NodeAssert.ok(result.startsWith("<system-reminder>"));
    NodeAssert.ok(result.endsWith("do the thing"));
    // The user's own text must remain the last thing the model reads.
    NodeAssert.ok(result.indexOf(CONTEXT_RECOVERY_TOOL_NAME) < result.indexOf("do the thing"));
  });

  it("still carries the reminder for an attachment-only turn", () => {
    const result = withContextRecoveryReminder("", "provider-handoff");
    NodeAssert.equal(result, contextRecoveryReminderBlock("provider-handoff"));
  });
});

describe("historyResetReminderBlock", () => {
  it("names the cause, forbids repeating it, and reads as an out-of-band note", () => {
    const block = historyResetReminderBlock(
      "Prompt too long: the maximum context length is 262144 tokens. The last tool result before the failure was the `read` tool result for /reports/overview_review.png (1.6 MB)",
    );
    NodeAssert.equal(block.startsWith("<system-reminder>\n"), true);
    NodeAssert.equal(block.endsWith("\n</system-reminder>"), true);
    NodeAssert.match(block, /restarted with a summary because the provider rejected/);
    NodeAssert.match(block, /overview_review\.png \(1\.6 MB\)\./);
    NodeAssert.match(block, /Do not repeat the step that caused it\./);
    NodeAssert.match(block, /downscale or crop images/);
  });
});
