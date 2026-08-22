import { describe, expect, it } from "vite-plus/test";

import { describeVoiceIssue, shouldAnnounceVoiceIssue } from "./voiceErrorNotice";

describe("shouldAnnounceVoiceIssue", () => {
  it("announces a failure", () => {
    expect(shouldAnnounceVoiceIssue({ message: "No credits left.", announced: null })).toBe(true);
  });

  it("stays quiet when there is nothing to report", () => {
    expect(shouldAnnounceVoiceIssue({ message: null, announced: null })).toBe(false);
  });

  it("does not repeat a message it has already announced", () => {
    expect(
      shouldAnnounceVoiceIssue({ message: "No credits left.", announced: "No credits left." }),
    ).toBe(false);
  });

  it("announces a different failure that follows an earlier one", () => {
    expect(
      shouldAnnounceVoiceIssue({
        message: "The connection dropped.",
        announced: "No credits left.",
      }),
    ).toBe(true);
  });
});

describe("describeVoiceIssue", () => {
  it("titles a fault as unavailable", () => {
    expect(describeVoiceIssue({ message: "No credits left.", severity: "error" })).toEqual({
      title: "Voice unavailable",
      description: "No credits left.",
      type: "error",
    });
  });

  it("does not dress a deliberate stop as a failure", () => {
    const announcement = describeVoiceIssue({
      message: "Voice stopped after 30 seconds of silence.",
      severity: "notice",
    });
    expect(announcement.type).toBe("info");
    expect(announcement.title).toBe("Voice ended");
  });

  it("treats an unlabelled message as a fault", () => {
    expect(describeVoiceIssue({ message: "Something broke.", severity: null }).type).toBe("error");
  });
});
