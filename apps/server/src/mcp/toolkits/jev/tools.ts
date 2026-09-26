import { Tool, Toolkit } from "effect/unstable/ai";
import { JevDecideError, JevDecideInput, JevDecideResult } from "./types.ts";

export const JevDecideTool = Tool.make("jev_decide", {
  description:
    "Evaluate supplied text with Jev 1.13 Free through OpenCode Zen. Returns typed choice, score, or yes/no (noul) probabilities; does not generate code or prose. Use atomic questions and inspect uncertainty before acting. Sends only the supplied state and questions to OpenCode's external free endpoint. Limited-time free model only, with no paid fallback. Up to 32 questions, 255 choice options, 2–10 score levels. Serialize structured state as text.",
  parameters: JevDecideInput,
  success: JevDecideResult,
  failure: JevDecideError,
})
  .annotate(Tool.Title, "Evaluate with Jev Free")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const JevToolkit = Toolkit.make(JevDecideTool);
