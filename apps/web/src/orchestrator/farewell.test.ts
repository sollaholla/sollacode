import { describe, expect, it } from "vite-plus/test";

import { isAssistantGoodbye, isPersonGoodbye, readVoiceStop } from "./farewell";

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

describe("a voice closing with AGENT_STOP", () => {
  it("hears it and keeps the words before it", () => {
    for (const [said, words] of [
      ["AGENT_STOP", ""],
      ["Okay, talk soon.\nAGENT_STOP", "Okay, talk soon."],
      ["All done. AGENT_STOP.", "All done."],
      ["Agent stop.", ""],
      ["All done. Agent underscore stop", "All done."],
      ["All done. AGENT STOP!", "All done."],
    ] as const) {
      expect(readVoiceStop(said), said).toEqual({ stop: true, words });
    }
  });

  it("does not hang up over the word in a sentence", () => {
    for (const said of [
      "I told the agent stop",
      "The AGENT_STOP token ends a turn in a chat.",
      "Should the agent stop?  I can ask it to keep going if you want.",
      "It's green.",
    ]) {
      expect(readVoiceStop(said), said).toEqual({ stop: false, words: said });
    }
  });
});
