import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { $getRoot, $isTextNode, HISTORY_MERGE_TAG, TextNode } from "lexical";
import { useEffect, useRef, useState } from "react";

import { findLeadingProviderSlashCommand } from "~/providerSlashCommands";
import { ProviderSlashCommandInfo } from "./chat/ProviderSlashCommandInfo";
import { Popover, PopoverPopup } from "./ui/popover";

/**
 * Inline style that marks the text of a leading provider command. `index.css`
 * gives anything carrying the custom property its link colour. A style, not a
 * node type: the command stays ordinary editable text, so typing, the caret,
 * and dictation behave exactly as they do everywhere else in the composer.
 */
export const COMPOSER_SLASH_COMMAND_STYLE = "--solla-slash-command: 1;";
const COMPOSER_SLASH_COMMAND_SELECTOR = '[style*="--solla-slash-command"]';

interface SlashCommandInfoTarget {
  readonly anchor: Element;
  readonly command: ServerProviderSlashCommand;
}

/** Whether nothing but whitespace comes before this node in the message. */
function $isAtMessageStart(node: TextNode): boolean {
  const parent = node.getParent();
  if (parent === null || !parent.is($getRoot().getFirstChild())) return false;
  for (
    let previous = node.getPreviousSibling();
    previous !== null;
    previous = previous.getPreviousSibling()
  ) {
    if (!$isTextNode(previous) || previous.getTextContent().trim().length > 0) return false;
  }
  return true;
}

/**
 * Keeps exactly the message's leading provider command marked: splits it out
 * of the text around it, and unmarks text that stopped being one.
 */
export function $markLeadingProviderSlashCommand(
  node: TextNode,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): void {
  const text = node.getTextContent();
  const leading = $isAtMessageStart(node) ? findLeadingProviderSlashCommand(text, commands) : null;
  const marked = node.getStyle() === COMPOSER_SLASH_COMMAND_STYLE;
  if (leading === null) {
    if (marked) node.setStyle("");
    return;
  }
  if (leading.start === 0 && leading.end === text.length) {
    if (!marked) node.setStyle(COMPOSER_SLASH_COMMAND_STYLE);
    return;
  }
  const commandIndex = leading.start === 0 ? 0 : 1;
  node.splitText(leading.start, leading.end).forEach((part, index) => {
    part.setStyle(index === commandIndex ? COMPOSER_SLASH_COMMAND_STYLE : "");
  });
}

/** The explanation card for a tapped command, anchored to its text. */
function SlashCommandInfoPopover(props: {
  readonly target: SlashCommandInfoTarget | null;
  readonly onClose: () => void;
}) {
  if (props.target === null) return null;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {/* The composer keeps focus: taking it would close a phone's keyboard. */}
      <PopoverPopup
        anchor={props.target.anchor}
        side="top"
        align="start"
        initialFocus={false}
        finalFocus={false}
      >
        <ProviderSlashCommandInfo command={props.target.command} />
      </PopoverPopup>
    </Popover>
  );
}

/** Link-colours the leading provider command in the rich composer. */
export function ComposerProviderSlashCommandPlugin(props: {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
}) {
  const [editor] = useLexicalComposerContext();
  const commandsRef = useRef(props.commands);
  commandsRef.current = props.commands;
  const commandsKey = props.commands.map((command) => command.name).join("\u0000");
  const [infoTarget, setInfoTarget] = useState<SlashCommandInfoTarget | null>(null);

  useEffect(
    () =>
      editor.registerNodeTransform(TextNode, (node) => {
        // Restyling mid-composition would disturb the input method's text.
        if (editor.isComposing()) return;
        $markLeadingProviderSlashCommand(node, commandsRef.current);
      }),
    [editor],
  );

  // Commands can arrive after the text was typed; look at it again.
  useEffect(() => {
    editor.update(
      () => {
        for (const node of $getRoot().getAllTextNodes()) node.markDirty();
      },
      { tag: HISTORY_MERGE_TAG },
    );
  }, [editor, commandsKey]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest(COMPOSER_SLASH_COMMAND_SELECTOR)
          : null;
      if (anchor === null) return;
      const name = (anchor.textContent ?? "").trim().replace(/^\//u, "");
      const command = commandsRef.current.find((candidate) => candidate.name === name);
      if (command) setInfoTarget({ anchor, command });
    };
    const unregisterRoot = editor.registerRootListener((root, previousRoot) => {
      previousRoot?.removeEventListener("click", onClick);
      root?.addEventListener("click", onClick);
    });
    // The card describes text that is no longer there once it is edited.
    const unregisterText = editor.registerTextContentListener(() => setInfoTarget(null));
    return () => {
      unregisterRoot();
      unregisterText();
    };
  }, [editor]);

  return <SlashCommandInfoPopover target={infoTarget} onClose={() => setInfoTarget(null)} />;
}

/**
 * The iOS composer is a plain textarea, which cannot colour part of its text.
 * While the message opens with a provider command, this draws the text behind
 * the textarea — same box, font and wrapping — with the command coloured, and
 * the textarea's own glyphs are made transparent over it. Only then: any other
 * message leaves the textarea exactly as it was.
 */
export function useNativeComposerSlashCommandOverlay(input: {
  readonly text: string;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
}) {
  const leading = findLeadingProviderSlashCommand(input.text, input.commands);
  const overlayRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLSpanElement>(null);
  const [infoTarget, setInfoTarget] = useState<SlashCommandInfoTarget | null>(null);

  useEffect(() => {
    if (leading === null) setInfoTarget(null);
  }, [leading]);

  return {
    active: leading !== null,
    overlay: (className: string | undefined) =>
      leading === null ? null : (
        <div
          ref={overlayRef}
          aria-hidden="true"
          data-native-composer-slash-command-overlay="true"
          className={[
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap wrap-break-word text-[16px] leading-relaxed text-foreground",
            className ?? "",
          ].join(" ")}
        >
          {input.text.slice(0, leading.start)}
          <span ref={commandRef} className="composer-provider-slash-command">
            {input.text.slice(leading.start, leading.end)}
          </span>
          {input.text.slice(leading.end)}
          {/* Keeps a trailing newline's empty line, as the textarea does. */}
          {"​"}
        </div>
      ),
    /** Mirror the textarea's scroll so the drawn text stays under it. */
    onScroll: (element: HTMLTextAreaElement) => {
      if (overlayRef.current) overlayRef.current.scrollTop = element.scrollTop;
    },
    /** A tap that lands on the command shows what it does. */
    onClick: (event: { clientX: number; clientY: number }) => {
      const commandElement = commandRef.current;
      if (leading === null || commandElement === null) return;
      for (const rect of commandElement.getClientRects()) {
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        ) {
          setInfoTarget({ anchor: commandElement, command: leading.command });
          return;
        }
      }
    },
    infoPopover: (
      <SlashCommandInfoPopover target={infoTarget} onClose={() => setInfoTarget(null)} />
    ),
  };
}
