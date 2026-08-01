import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import {
  CONTEXT_RECOVERY_TOOL_NAME,
  contextRecoveryReminder,
  contextRecoveryReminderBlock,
  withContextRecoveryReminder,
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
