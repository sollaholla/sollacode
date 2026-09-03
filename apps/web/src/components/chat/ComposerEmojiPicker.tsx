import { EllipsisIcon, SearchIcon, SmilePlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  loadRecentComposerEmojis,
  recordComposerEmojiUsage,
  searchComposerEmojis,
} from "./composerEmoji";

export function ComposerEmojiPicker(props: {
  disabled: boolean;
  hasTextUnderlay: boolean;
  onSelect: (emoji: string) => void;
}) {
  const [quickDrawerOpen, setQuickDrawerOpen] = useState(false);
  const [fullPickerOpen, setFullPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentEmojis, setRecentEmojis] = useState(loadRecentComposerEmojis);
  const results = useMemo(() => searchComposerEmojis(query), [query]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const closeDrawer = () => {
    setQuickDrawerOpen(false);
    setFullPickerOpen(false);
    setQuery("");
  };

  // Collapse when the next interaction is somewhere else. The full picker
  // renders through a portal, so "outside" has to mean outside this row AND
  // outside the popup — testing only the row would tear the drawer down the
  // moment someone reached for the emoji table it opened.
  useEffect(() => {
    if (!quickDrawerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-slot='popover-popup']")) return;
      closeDrawer();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [quickDrawerOpen]);

  const selectEmoji = (emoji: string) => {
    recordComposerEmojiUsage(emoji);
    props.onSelect(emoji);
  };

  const toggleQuickDrawer = () => {
    if (quickDrawerOpen) {
      closeDrawer();
      return;
    }
    setRecentEmojis(loadRecentComposerEmojis());
    setQuickDrawerOpen(true);
  };

  return (
    <div
      ref={rootRef}
      data-chat-composer-emoji-picker="true"
      data-chat-composer-emoji-underlay={props.hasTextUnderlay ? "true" : "false"}
      className={cn(
        "flex h-7 items-center rounded-md bg-background/90 px-0.5 shadow-sm ring-1 ring-border/50 transition-opacity duration-150",
        // Fades only while draft text runs underneath it. 12% was effectively
        // invisible on a pointer device — you had to already know it was there
        // to hover it back — while `max-sm:opacity-100` did the opposite on a
        // phone, holding it fully opaque over exactly the layout with the least
        // room, so it covered the text it was trying to stay out of the way of.
        // Recessed but legible with a mouse, and thinner at phone widths where
        // the collision is worst; any interaction brings it straight back.
        //
        // Keyed on width alone, not width + portrait + coarse pointer. Width is
        // the condition known to hold on the phone that reported this — it is
        // what `max-sm:opacity-100` was matching — whereas the other two are
        // assumptions about the device. A narrow desktop window fading too is
        // the cheaper mistake: hover restores it there instantly.
        props.hasTextUnderlay && !fullPickerOpen
          ? "opacity-45 hover:opacity-100 focus-within:opacity-100 active:opacity-100 max-sm:opacity-25"
          : "opacity-100",
      )}
    >
      {quickDrawerOpen
        ? recentEmojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="flex size-6 items-center justify-center rounded text-sm leading-none hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              disabled={props.disabled}
              aria-label={`Insert ${emoji}`}
              title={`Insert ${emoji}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selectEmoji(emoji)}
            >
              {emoji}
            </button>
          ))
        : null}

      {quickDrawerOpen ? (
        <Popover
          open={fullPickerOpen}
          onOpenChange={(nextOpen) => {
            setFullPickerOpen(nextOpen);
            if (!nextOpen) setQuery("");
          }}
        >
          <PopoverTrigger
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            disabled={props.disabled}
            aria-label="Open searchable emoji picker"
            title="More emoji"
            onPointerDown={(event) => event.preventDefault()}
          >
            <EllipsisIcon className="size-4" />
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="end"
            sideOffset={8}
            className="w-80 max-w-[calc(100vw-1rem)]"
            viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
            aria-label="Emoji picker"
          >
            <div className="relative mb-2">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search emoji"
                aria-label="Search emoji"
                className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div
              role="listbox"
              aria-label="Emoji results"
              className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto pr-1"
            >
              {results.map((item) => (
                <button
                  key={item.emoji}
                  type="button"
                  role="option"
                  aria-label={item.label}
                  title={item.label}
                  className="flex aspect-square items-center justify-center rounded-md text-xl hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => selectEmoji(item.emoji)}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
            {results.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No emoji found</p>
            ) : null}
          </PopoverPopup>
        </Popover>
      ) : null}

      {/* Last, therefore rightmost: this row is anchored to the right edge and
          grows leftwards, so whatever renders last stays under the spot that
          was just tapped. With the toggle first, opening slid it left and put
          the "more" ellipsis under that thumb — a second tap opened the full
          table instead of closing the drawer. Now a second tap toggles, and
          the ellipsis sits just inside it. */}
      <button
        type="button"
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        disabled={props.disabled}
        aria-label={quickDrawerOpen ? "Close emoji shortcuts" : "Open emoji shortcuts"}
        aria-expanded={quickDrawerOpen}
        title={quickDrawerOpen ? "Close emoji shortcuts" : "Emoji"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleQuickDrawer}
      >
        <SmilePlusIcon className="size-4" />
      </button>
    </div>
  );
}
