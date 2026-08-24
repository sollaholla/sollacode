import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface BoundedTextPreview {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Builds a small render payload without mounting the full contract-sized text
 * until the user asks for it. Newlines count toward the limit so pasted logs
 * cannot produce a tall collapsed block even when their character count is low.
 */
export function boundedTextPreview(
  text: string,
  options: { readonly maxCharacters?: number; readonly maxLines?: number } = {},
): BoundedTextPreview {
  const maxCharacters = Math.max(1, options.maxCharacters ?? 420);
  const maxLines = Math.max(1, options.maxLines ?? 5);
  const lines = text.split("\n");
  const lineBounded = lines.slice(0, maxLines).join("\n");
  const truncated = lines.length > maxLines || lineBounded.length > maxCharacters;
  let end = Math.min(lineBounded.length, truncated ? maxCharacters - 1 : maxCharacters);
  const lastCodeUnit = lineBounded.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  const characterBounded = lineBounded.slice(0, end);
  return {
    text: truncated ? `${characterBounded.trimEnd()}…` : characterBounded,
    truncated,
  };
}

export function BoundedCollaborationText(props: {
  readonly text: string;
  readonly collapsedLabel?: string;
  readonly expandedLabel?: string;
  readonly className?: string;
  readonly maxCharacters?: number;
  readonly maxLines?: number;
  readonly expandedMaxHeightClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const preview = boundedTextPreview(props.text, {
    ...(props.maxCharacters === undefined ? {} : { maxCharacters: props.maxCharacters }),
    ...(props.maxLines === undefined ? {} : { maxLines: props.maxLines }),
  });
  const shownText = expanded ? props.text : preview.text;

  return (
    <div className={cn("min-w-0", props.className)}>
      <p
        id={contentId}
        className={cn(
          "whitespace-pre-wrap break-words text-xs leading-relaxed [overflow-wrap:anywhere]",
          expanded &&
            "overflow-x-hidden overflow-y-auto pr-1 " +
              (props.expandedMaxHeightClassName ?? "max-h-48"),
        )}
      >
        {shownText}
      </p>
      {preview.truncated ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-controls={contentId}
          aria-expanded={expanded}
          className="-ml-1 mt-1 h-6 rounded-md px-1.5 text-[11px] text-muted-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? (props.expandedLabel ?? "Show less")
            : (props.collapsedLabel ?? "Show full text")}
        </Button>
      ) : null}
    </div>
  );
}
