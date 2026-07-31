import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  composerTransferHtml,
  discardComposerTransfer,
  hasTransferableComposerContent,
  readComposerTransferFromClipboard,
  stageComposerTransfer,
  writeComposerTransferToClipboard,
} from "./composerTransferClipboard";

function clipboardData(values: Record<string, string>): Pick<DataTransfer, "getData"> {
  return {
    getData: (type) => values[type] ?? "",
  };
}

describe("composer transfer clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { prompt: "", attachmentCount: 0, expected: false },
    { prompt: "Move this prompt", attachmentCount: 0, expected: true },
    { prompt: "", attachmentCount: 1, expected: true },
    { prompt: "Move this prompt", attachmentCount: 2, expected: true },
  ])("detects transferable text and attachments", ({ prompt, attachmentCount, expected }) => {
    expect(hasTransferableComposerContent(prompt, attachmentCount)).toBe(expected);
  });

  it("round-trips all staged files through the HTML clipboard marker", async () => {
    const first = new File(["first"], "first.png", { type: "image/png", lastModified: 10 });
    const second = new File(["second"], "second.webp", {
      type: "image/webp",
      lastModified: 20,
    });
    const staged = stageComposerTransfer("hello\nworld", [first, second]);
    const resolved = readComposerTransferFromClipboard(
      clipboardData({ "text/html": composerTransferHtml(staged) }),
    );

    expect(resolved?.prompt).toBe("hello\nworld");
    expect(resolved?.files.map((file) => [file.name, file.type, file.lastModified])).toEqual([
      ["first.png", "image/png", 10],
      ["second.webp", "image/webp", 20],
    ]);
    expect(resolved?.files[0]).not.toBe(first);
    expect(await resolved?.files[0]?.text()).toBe("first");

    discardComposerTransfer(staged.token);
    expect(
      readComposerTransferFromClipboard(
        clipboardData({ "text/html": composerTransferHtml(staged) }),
      ),
    ).toBeNull();
  });

  it("escapes prompt markup without hiding the transfer marker", () => {
    const staged = stageComposerTransfer(`<script>"cut"</script>`, []);
    const html = composerTransferHtml(staged);

    expect(html).toContain(`data-solla-composer-transfer="${staged.token}"`);
    expect(html).toContain("&lt;script&gt;&quot;cut&quot;&lt;/script&gt;");
    expect(html).not.toContain("<script>");

    discardComposerTransfer(staged.token);
  });

  it("ignores arbitrary image clipboard content without a staged transfer token", () => {
    expect(
      readComposerTransferFromClipboard(
        clipboardData({
          "text/plain": "draft",
          "text/html": '<img src="data:image/png;base64,AAAA">',
        }),
      ),
    ).toBeNull();
  });

  it("writes plain text, HTML marker, and the internal token in the button gesture", async () => {
    const values: Record<string, string> = {};
    let copyListener: ((event: ClipboardEvent) => void) | null = null;
    vi.stubGlobal("document", {
      addEventListener: (type: string, listener: (event: ClipboardEvent) => void) => {
        if (type === "copy") copyListener = listener;
      },
      removeEventListener: vi.fn(),
      execCommand: (command: string) => {
        expect(command).toBe("copy");
        copyListener?.({
          preventDefault: vi.fn(),
          clipboardData: {
            setData: (type: string, value: string) => {
              values[type] = value;
            },
          },
        } as unknown as ClipboardEvent);
        return true;
      },
    });
    const staged = stageComposerTransfer("move me", []);

    await expect(writeComposerTransferToClipboard(staged)).resolves.toBe(true);
    expect(values["text/plain"]).toBe("move me");
    expect(values["text/html"]).toContain(`data-solla-composer-transfer="${staged.token}"`);
    expect(values["application/x-solla-composer-transfer"]).toBe(staged.token);

    discardComposerTransfer(staged.token);
  });
});
