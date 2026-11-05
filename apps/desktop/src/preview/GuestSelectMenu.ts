/**
 * Draws a `<select>`'s list inside the page instead of the browser's own popup.
 *
 * The browser's popup is a separate window on the host's screen: the picture a
 * remote viewer gets never shows it, and it opens over whatever the person at
 * the host is doing. This list is ordinary page content, so it is part of the
 * picture and takes the same taps as everything else. The `<select>` itself is
 * left exactly as the page styled it. `appearance: base-select` would also keep
 * the list in the page, but it restyles every dropdown of a site being built.
 *
 * Runs inside the guest, so it must stay self-contained: it is sent as source
 * text, see `GUEST_SELECT_MENU_SOURCE`. Nothing here may use innerHTML or
 * `<style>`, which a page's security policy can refuse.
 */
export function installGuestSelectMenu(): void {
  const installed = Symbol.for("solla.guestSelectMenu");
  if (installed in window) return;
  Object.defineProperty(window, installed, { value: true });

  const TYPE_AHEAD_RESET_MS = 800;
  const VIEWPORT_MARGIN = 8;
  const onMac = navigator.platform.startsWith("Mac");

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host {
      all: initial !important;
      display: block !important;
      position: fixed !important;
      inset: 0 !important;
      width: 0 !important;
      height: 0 !important;
      overflow: visible !important;
    }
    [role="listbox"] {
      position: fixed;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 4px;
      border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
    }
    [role="option"] {
      box-sizing: border-box;
      padding: 6px 12px 6px 26px;
      border-radius: 5px;
      position: relative;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: default;
    }
    [role="option"][data-active] {
      background: color-mix(in srgb, currentColor 16%, transparent);
    }
    [role="option"][aria-selected="true"]::before {
      content: "\\2713";
      position: absolute;
      left: 8px;
    }
    [role="option"][aria-disabled="true"] {
      opacity: 0.45;
    }
    [role="presentation"] {
      padding: 6px 12px 2px 8px;
      font-weight: 600;
      white-space: pre;
    }
    [role="group"] [role="option"] {
      padding-left: 34px;
    }
    [role="group"] [role="option"][aria-selected="true"]::before {
      left: 16px;
    }
  `);

  interface Row {
    readonly element: HTMLElement;
    readonly option: HTMLOptionElement;
    readonly enabled: boolean;
  }
  interface OpenMenu {
    readonly select: HTMLSelectElement;
    readonly host: HTMLElement;
    readonly rows: ReadonlyArray<Row>;
    active: Row | null;
    typed: string;
    typedAt: number;
  }
  let menu: OpenMenu | null = null;

  const asSelect = (target: EventTarget | undefined): HTMLSelectElement | null =>
    target instanceof Element && target.tagName === "SELECT" ? (target as HTMLSelectElement) : null;

  /** The ones that open a popup. A list box, or a page's own base-select, is already in the page. */
  const opensPopup = (select: HTMLSelectElement): boolean =>
    !select.multiple &&
    select.size <= 1 &&
    !select.matches(":disabled") &&
    getComputedStyle(select).appearance !== "base-select";

  const setActive = (shown: OpenMenu, row: Row | null): void => {
    shown.active?.element.removeAttribute("data-active");
    shown.active = row;
    if (row === null) return;
    row.element.setAttribute("data-active", "");
    row.element.scrollIntoView({ block: "nearest" });
  };

  const close = (): void => {
    menu?.host.remove();
    menu = null;
  };

  const choose = (shown: OpenMenu, row: Row): void => {
    close();
    const { select } = shown;
    if (!select.isConnected) return;
    // A live page can rebuild the options while the list is open.
    const option = select.contains(row.option)
      ? row.option
      : Array.from(select.options).find((candidate) => candidate.value === row.option.value);
    select.focus({ preventScroll: true });
    if (option === undefined || option.selected) return;
    option.selected = true;
    // What a real choice fires. Frameworks listen for one or both.
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const addRow = (rows: Array<Row>, parent: HTMLElement, option: HTMLOptionElement): void => {
    if (option.hidden) return;
    const element = document.createElement("div");
    const enabled = !option.matches(":disabled");
    element.setAttribute("role", "option");
    element.setAttribute("aria-selected", String(option.selected));
    element.setAttribute("aria-disabled", String(!enabled));
    element.textContent = option.label;
    parent.append(element);
    rows.push({ element, option, enabled });
  };

  const placeList = (list: HTMLElement, select: HTMLSelectElement): void => {
    const anchor = select.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    list.style.minWidth = `${Math.min(anchor.width, viewportWidth - VIEWPORT_MARGIN * 2)}px`;
    list.style.maxWidth = `${viewportWidth - VIEWPORT_MARGIN * 2}px`;
    const below = viewportHeight - anchor.bottom - VIEWPORT_MARGIN;
    const above = anchor.top - VIEWPORT_MARGIN;
    const height = list.getBoundingClientRect().height;
    const opensBelow = height <= below || below >= above;
    const room = Math.max(opensBelow ? below : above, 0);
    const shown = Math.min(height, room);
    list.style.maxHeight = `${room}px`;
    list.style.top = `${opensBelow ? anchor.bottom : anchor.top - shown}px`;
    const width = list.getBoundingClientRect().width;
    const left = Math.min(anchor.left, viewportWidth - VIEWPORT_MARGIN - width);
    list.style.left = `${Math.max(left, VIEWPORT_MARGIN)}px`;
  };

  const open = (select: HTMLSelectElement): void => {
    close();
    const style = getComputedStyle(select);
    const host = document.createElement("div");
    host.popover = "manual";
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [sheet];

    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", select.getAttribute("aria-label") ?? select.name);
    list.style.colorScheme = style.colorScheme;
    list.style.color = style.color;
    list.style.fontFamily = style.fontFamily;
    list.style.fontSize = style.fontSize;
    // A see-through dropdown still needs a solid list over the page.
    const clear = /^rgba\(.*, 0\)$|^transparent$/u.test(style.backgroundColor);
    list.style.backgroundColor = clear ? "Canvas" : style.backgroundColor;

    const rows: Array<Row> = [];
    for (const child of Array.from(select.children)) {
      if (child.tagName === "OPTGROUP") {
        const group = document.createElement("div");
        group.setAttribute("role", "group");
        const title = document.createElement("div");
        title.setAttribute("role", "presentation");
        title.textContent = (child as HTMLOptGroupElement).label;
        group.append(title);
        for (const option of Array.from((child as HTMLOptGroupElement).children)) {
          if (option.tagName === "OPTION") addRow(rows, group, option as HTMLOptionElement);
        }
        list.append(group);
      } else if (child.tagName === "OPTION") {
        addRow(rows, list, child as HTMLOptionElement);
      }
    }
    if (rows.length === 0) return;
    root.append(list);

    const shown: OpenMenu = { select, host, rows, active: null, typed: "", typedAt: 0 };
    list.addEventListener("mousemove", (event) => {
      const row = rows.find((candidate) => event.composedPath().includes(candidate.element));
      if (row?.enabled === true && row !== shown.active) setActive(shown, row);
    });
    list.addEventListener("click", (event) => {
      const row = rows.find((candidate) => event.composedPath().includes(candidate.element));
      if (row?.enabled === true) choose(shown, row);
    });
    // The list belongs to the dropdown, so a page's click-outside handling
    // must not see it, and pressing it must not take focus from the dropdown.
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      host.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "mousedown") event.preventDefault();
      });
    }

    // Inside a modal dialog everything else is inert, and a shadow tree can
    // only be reached from within.
    const scope = select.getRootNode();
    const parent =
      scope instanceof ShadowRoot ? scope : (select.closest("dialog") ?? document.documentElement);
    parent.append(host);
    host.showPopover();
    placeList(list, select);
    menu = shown;
    setActive(shown, rows.find((row) => row.option.selected) ?? null);
  };

  const enabledRows = (shown: OpenMenu): ReadonlyArray<Row> =>
    shown.rows.filter((row) => row.enabled);

  const moveActive = (shown: OpenMenu, step: number): void => {
    const rows = enabledRows(shown);
    const index = shown.active === null ? -1 : rows.indexOf(shown.active);
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + step))];
    if (next !== undefined) setActive(shown, next);
  };

  const typeAhead = (shown: OpenMenu, key: string, now: number): void => {
    shown.typed = now - shown.typedAt > TYPE_AHEAD_RESET_MS ? key : shown.typed + key;
    shown.typedAt = now;
    const typed = shown.typed.toLowerCase();
    const match = enabledRows(shown).find((row) =>
      row.option.label.trim().toLowerCase().startsWith(typed),
    );
    if (match !== undefined) setActive(shown, match);
  };

  /** What the open list does with a key. False leaves the key to the page. */
  const handleOpenKey = (shown: OpenMenu, event: KeyboardEvent): boolean => {
    const typing = shown.typed !== "" && event.timeStamp - shown.typedAt <= TYPE_AHEAD_RESET_MS;
    switch (event.key) {
      case "ArrowDown":
        moveActive(shown, 1);
        return true;
      case "ArrowUp":
        moveActive(shown, -1);
        return true;
      case "PageDown":
        moveActive(shown, 10);
        return true;
      case "PageUp":
        moveActive(shown, -10);
        return true;
      case "Home":
        moveActive(shown, -shown.rows.length);
        return true;
      case "End":
        moveActive(shown, shown.rows.length);
        return true;
      case "Escape":
        close();
        return true;
      case "Tab":
        if (shown.active !== null) choose(shown, shown.active);
        return false;
      case "Enter":
        if (shown.active !== null) choose(shown, shown.active);
        else close();
        return true;
      case " ":
        if (typing) typeAhead(shown, " ", event.timeStamp);
        else if (shown.active !== null) choose(shown, shown.active);
        return true;
      default:
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
        typeAhead(shown, event.key, event.timeStamp);
        return true;
    }
  };

  const keyOpensList = (event: KeyboardEvent): boolean => {
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
    if (event.key === " " || event.key === "F4" || (arrow && event.altKey)) return true;
    return onMac && (arrow || event.key === "Enter");
  };

  // Decided on the dropdown itself, after its own handlers and before any
  // parent can stop the event: a page that cancels the press has its own list.
  const pressedSelect = (event: Event): void => {
    const select = event.currentTarget as HTMLSelectElement;
    if (event.defaultPrevented) return;
    event.preventDefault();
    select.focus({ preventScroll: true });
    open(select);
  };
  const keyedSelect = (event: Event): void => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    open(event.currentTarget as HTMLSelectElement);
  };

  window.addEventListener(
    "mousedown",
    (event) => {
      const shown = menu;
      if (shown !== null && event.composedPath().includes(shown.host)) return;
      const select = asSelect(event.composedPath()[0]);
      close();
      if (!event.isTrusted || event.button !== 0 || select === null) return;
      if (shown?.select === select) {
        event.preventDefault();
      } else if (opensPopup(select)) {
        select.addEventListener("mousedown", pressedSelect, { once: true });
      }
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted) return;
      if (menu !== null) {
        if (handleOpenKey(menu, event)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const select = asSelect(event.composedPath()[0]);
      if (select !== null && keyOpensList(event) && opensPopup(select)) {
        select.addEventListener("keydown", keyedSelect, { once: true });
      }
    },
    true,
  );

  // The dropdown moved. Scrolling the list itself is the one scroll that
  // leaves it open.
  window.addEventListener(
    "scroll",
    (event) => {
      if (menu !== null && !event.composedPath().includes(menu.host)) close();
    },
    true,
  );
  window.addEventListener("resize", close);
}

/** Sent to every frame of a preview page. Running it twice in a document is harmless. */
export const GUEST_SELECT_MENU_SOURCE = `(${installGuestSelectMenu.toString()})()`;
