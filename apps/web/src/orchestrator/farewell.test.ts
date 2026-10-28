import { describe, expect, it } from "vite-plus/test";

import { isAssistantGoodbye, isPersonGoodbye } from "./farewell";

describe("spoken goodbyes", () => {
  it("hears the person closing the call", () => {
    for (const words of [
      "Okay, bye.",
      "Thanks, that's all for now",
      "Great, talk to you later!",
      "Perfect. Goodbye",
      "You can hang up now",
      "I'm done, thanks",
      "Alright, gotta go, bye-bye",
    ]) {
      expect(isPersonGoodbye(words), words).toBe(true);
    }
  });

  it("does not hear a goodbye in ordinary requests", () => {
    for (const words of [
      "Can you check the deploy?",
      "Do that later, first look at staging",
      "Byers said the build is red",
      "What's the status of the bye-laws doc review and the other tickets we opened this morning about the deploy pipeline?",
    ]) {
      expect(isPersonGoodbye(words), words).toBe(false);
    }
  });

  it("hears the assistant answer with a goodbye", () => {
    expect(isAssistantGoodbye("You're welcome! Talk soon, bye.")).toBe(true);
    expect(isAssistantGoodbye("Take care!")).toBe(true);
    expect(isAssistantGoodbye("Sure, I'll check the deploy now.")).toBe(false);
  });

  it("only listens to how an utterance ends", () => {
    expect(
      isPersonGoodbye(
        "Bye for now — actually wait, before you go, can you also check the staging logs and the queue?",
      ),
    ).toBe(false);
  });
});
