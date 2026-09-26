import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  TextNode,
  type LexicalEditor,
} from "lexical";
import { describe, expect, it } from "vite-plus/test";

import {
  $markLeadingProviderSlashCommand,
  COMPOSER_SLASH_COMMAND_STYLE,
} from "./ComposerProviderSlashCommands";

const COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "compact", description: "Clear history but keep a summary in context" },
];

function makeEditor(): LexicalEditor {
  const editor = createEditor({ onError: (error) => Promise.reject(error) });
  editor.registerNodeTransform(TextNode, (node) =>
    $markLeadingProviderSlashCommand(node, COMMANDS),
  );
  return editor;
}

function setText(editor: LexicalEditor, ...lines: string[]) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      lines.forEach((line, index) => {
        if (index > 0) paragraph.append($createLineBreakNode());
        paragraph.append($createTextNode(line));
      });
      root.append(paragraph);
    },
    { discrete: true },
  );
}

/** Each text node as [text, marked]. */
function textRuns(editor: LexicalEditor): Array<[string, boolean]> {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .map((node): [string, boolean] => [
        node.getTextContent(),
        node.getStyle() === COMPOSER_SLASH_COMMAND_STYLE,
      ]),
  );
}

describe("$markLeadingProviderSlashCommand", () => {
  it("marks the leading command and leaves the text after it plain", () => {
    const editor = makeEditor();
    setText(editor, "/compact keep the auth notes");
    expect(textRuns(editor)).toEqual([
      ["/compact", true],
      [" keep the auth notes", false],
    ]);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "/compact keep the auth notes",
    );
  });

  it("marks a command that is the whole message", () => {
    const editor = makeEditor();
    setText(editor, "/compact");
    expect(textRuns(editor)).toEqual([["/compact", true]]);
  });

  it("unmarks the command once editing stops it being one", () => {
    const editor = makeEditor();
    setText(editor, "/compact");
    editor.update(
      () => {
        const node = $getRoot().getAllTextNodes()[0]!;
        node.setTextContent("/compacting");
      },
      { discrete: true },
    );
    expect(textRuns(editor)).toEqual([["/compacting", false]]);
  });

  it("leaves a command anywhere but the start of the message plain", () => {
    const editor = makeEditor();
    setText(editor, "please /compact");
    expect(textRuns(editor)).toEqual([["please /compact", false]]);
    setText(editor, "first line", "/compact");
    expect(textRuns(editor).every(([, marked]) => !marked)).toBe(true);
  });
});
