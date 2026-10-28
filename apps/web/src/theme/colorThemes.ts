/**
 * Named color themes, in the spirit of VS Code's Color Theme picker.
 *
 * Solla Light and Solla Dark live in index.css and need no variables here: a
 * named theme instead declares a compact palette, and
 * `deriveColorThemeVariables` expands it into every CSS variable the app
 * paints with. Those variables are applied inline on <html>, which outranks
 * the stylesheet's own light and dark blocks, so components keep naming the
 * same tokens. The theme's `kind` still drives the `.dark` class, so every
 * `dark:` utility keeps working.
 */
export type ColorThemeKind = "light" | "dark";

export interface ColorThemePalette {
  /** App background. */
  readonly page: string;
  /** Cards and the main panel surface. */
  readonly card: string;
  /** Sidebar and navigation surface. */
  readonly sidebar: string;
  /** Popovers, menus and muted fills. */
  readonly tile: string;
  /** Hover and accent fills. */
  readonly hover: string;
  readonly line: string;
  readonly lineStrong: string;
  /** Primary text. */
  readonly text1: string;
  /** Secondary text; also muted foreground. */
  readonly text2: string;
  readonly text3: string;
  readonly text4: string;
  /** The theme's signature color: primary buttons, focus rings, selection. */
  readonly accent: string;
  /** Text drawn on top of the accent. */
  readonly onAccent: string;
  readonly ok: string;
  readonly danger: string;
  readonly warn: string;
  readonly info: string;
}

/** The 16 terminal colors, in xterm's ITheme names. */
export interface TerminalAnsiPalette {
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

export interface ColorThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: ColorThemeKind;
  readonly highContrast?: boolean;
  /** Shiki theme bundled with @pierre/diffs, used for code blocks and diffs. */
  readonly syntaxTheme: string;
  /** Copied from the Shiki theme's terminal.ansi* colors. */
  readonly ansi: TerminalAnsiPalette;
  readonly palette: ColorThemePalette;
}

export const COLOR_THEMES = [
  {
    id: "dark-high-contrast",
    label: "Dark High Contrast",
    kind: "dark",
    highContrast: true,
    syntaxTheme: "github-dark-high-contrast",
    ansi: {
      black: "#7a828e",
      red: "#ff9492",
      green: "#26cd4d",
      yellow: "#f0b72f",
      blue: "#71b7ff",
      magenta: "#cb9eff",
      cyan: "#39c5cf",
      white: "#d9dee3",
      brightBlack: "#9ea7b3",
      brightRed: "#ffb1af",
      brightGreen: "#4ae168",
      brightYellow: "#f7c843",
      brightBlue: "#91cbff",
      brightMagenta: "#dbb7ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    },
    palette: {
      page: "#000000",
      card: "#000000",
      sidebar: "#000000",
      tile: "#0c0c0c",
      hover: "#1c1c1c",
      line: "rgb(111 195 223 / 70%)",
      lineStrong: "#6fc3df",
      text1: "#ffffff",
      text2: "#e8e8e8",
      text3: "#cccccc",
      text4: "#a8a8a8",
      accent: "#f38518",
      onAccent: "#000000",
      ok: "#89d185",
      danger: "#f48771",
      warn: "#ffd700",
      info: "#75beff",
    },
  },
  {
    id: "light-high-contrast",
    label: "Light High Contrast",
    kind: "light",
    highContrast: true,
    syntaxTheme: "github-light-high-contrast",
    ansi: {
      black: "#0e1116",
      red: "#a0111f",
      green: "#024c1a",
      yellow: "#3f2200",
      blue: "#0349b4",
      magenta: "#622cbc",
      cyan: "#1b7c83",
      white: "#66707b",
      brightBlack: "#4b535d",
      brightRed: "#86061d",
      brightGreen: "#055d20",
      brightYellow: "#4e2c00",
      brightBlue: "#1168e3",
      brightMagenta: "#844ae7",
      brightCyan: "#3192aa",
      brightWhite: "#88929d",
    },
    palette: {
      page: "#ffffff",
      card: "#ffffff",
      sidebar: "#ffffff",
      tile: "#f2f2f2",
      hover: "#e6e6e6",
      line: "rgb(15 74 133 / 75%)",
      lineStrong: "#0f4a85",
      text1: "#000000",
      text2: "#1f1f1f",
      text3: "#3b3b3b",
      text4: "#595959",
      accent: "#0f4a85",
      onAccent: "#ffffff",
      ok: "#1a6b25",
      danger: "#b5200d",
      warn: "#7a4a00",
      info: "#0f4a85",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    kind: "dark",
    syntaxTheme: "dracula",
    ansi: {
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
    palette: {
      page: "#282a36",
      card: "#2d2f3d",
      sidebar: "#21222c",
      tile: "#343746",
      hover: "#3c3f51",
      line: "rgb(98 114 164 / 32%)",
      lineStrong: "rgb(98 114 164 / 52%)",
      text1: "#f8f8f2",
      text2: "#c5c6d6",
      text3: "#8e96bd",
      text4: "#6272a4",
      accent: "#bd93f9",
      onAccent: "#1e1f29",
      ok: "#50fa7b",
      danger: "#ff5555",
      warn: "#ffb86c",
      info: "#8be9fd",
    },
  },
  {
    id: "nord",
    label: "Nord",
    kind: "dark",
    syntaxTheme: "nord",
    ansi: {
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
    palette: {
      page: "#2e3440",
      card: "#323846",
      sidebar: "#2a2f3a",
      tile: "#3b4252",
      hover: "#434c5e",
      line: "rgb(216 222 233 / 10%)",
      lineStrong: "rgb(216 222 233 / 19%)",
      text1: "#eceff4",
      text2: "#c5ccd9",
      text3: "#939eb4",
      text4: "#677389",
      accent: "#88c0d0",
      onAccent: "#2e3440",
      ok: "#a3be8c",
      danger: "#bf616a",
      warn: "#d08770",
      info: "#81a1c1",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    kind: "dark",
    syntaxTheme: "monokai",
    ansi: {
      black: "#333333",
      red: "#c4265e",
      green: "#86b42b",
      yellow: "#b3b42b",
      blue: "#6a7ec8",
      magenta: "#8c6bc8",
      cyan: "#56adbc",
      white: "#e3e3dd",
      brightBlack: "#666666",
      brightRed: "#f92672",
      brightGreen: "#a6e22e",
      brightYellow: "#e2e22e",
      brightBlue: "#819aff",
      brightMagenta: "#ae81ff",
      brightCyan: "#66d9ef",
      brightWhite: "#f8f8f2",
    },
    palette: {
      page: "#272822",
      card: "#2d2e27",
      sidebar: "#1f201c",
      tile: "#3a3a31",
      hover: "#46463c",
      line: "rgb(248 248 242 / 9%)",
      lineStrong: "rgb(248 248 242 / 17%)",
      text1: "#f8f8f2",
      text2: "#d0d0c4",
      text3: "#9a9a8f",
      text4: "#75715e",
      accent: "#e6db74",
      onAccent: "#272822",
      ok: "#a6e22e",
      danger: "#f92672",
      warn: "#fd971f",
      info: "#66d9ef",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    kind: "dark",
    syntaxTheme: "one-dark-pro",
    ansi: {
      black: "#3f4451",
      red: "#e05561",
      green: "#8cc265",
      yellow: "#d18f52",
      blue: "#4aa5f0",
      magenta: "#c162de",
      cyan: "#42b3c2",
      white: "#d7dae0",
      brightBlack: "#4f5666",
      brightRed: "#ff616e",
      brightGreen: "#a5e075",
      brightYellow: "#f0a45d",
      brightBlue: "#4dc4ff",
      brightMagenta: "#de73ff",
      brightCyan: "#4cd1e0",
      brightWhite: "#e6e6e6",
    },
    palette: {
      page: "#282c34",
      card: "#2c313a",
      sidebar: "#21252b",
      tile: "#333842",
      hover: "#3a3f4b",
      line: "rgb(171 178 191 / 11%)",
      lineStrong: "rgb(171 178 191 / 20%)",
      text1: "#dcdfe4",
      text2: "#abb2bf",
      text3: "#848b98",
      text4: "#5c6370",
      accent: "#61afef",
      onAccent: "#1e2127",
      ok: "#98c379",
      danger: "#e06c75",
      warn: "#d19a66",
      info: "#56b6c2",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    syntaxTheme: "solarized-dark",
    ansi: {
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    palette: {
      page: "#002b36",
      card: "#03313d",
      sidebar: "#00252f",
      tile: "#073642",
      hover: "#0d4250",
      line: "rgb(147 161 161 / 15%)",
      lineStrong: "rgb(147 161 161 / 26%)",
      text1: "#eee8d5",
      text2: "#a9b6b4",
      text3: "#839496",
      text4: "#5f777d",
      accent: "#2aa1e8",
      onAccent: "#002b36",
      ok: "#9bb000",
      danger: "#ef4b44",
      warn: "#e2702f",
      info: "#2aa198",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    syntaxTheme: "solarized-light",
    ansi: {
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    palette: {
      page: "#fdf6e3",
      card: "#fffbf0",
      sidebar: "#f6efda",
      tile: "#eee8d5",
      hover: "#e7e0ca",
      line: "rgb(88 110 117 / 15%)",
      lineStrong: "rgb(88 110 117 / 27%)",
      text1: "#073642",
      text2: "#4f656c",
      text3: "#6c8187",
      text4: "#93a1a1",
      accent: "#1b76b6",
      onAccent: "#ffffff",
      ok: "#6b7a00",
      danger: "#c52a24",
      warn: "#b8400f",
      info: "#1f8a83",
    },
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    kind: "dark",
    syntaxTheme: "github-dark-default",
    ansi: {
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    },
    palette: {
      page: "#0d1117",
      card: "#151b23",
      sidebar: "#010409",
      tile: "#212830",
      hover: "#262c36",
      line: "#30363d",
      lineStrong: "#3d444d",
      text1: "#f0f6fc",
      text2: "#b7bdc8",
      text3: "#9198a1",
      text4: "#656c76",
      accent: "#4493f8",
      onAccent: "#0d1117",
      ok: "#3fb950",
      danger: "#f85149",
      warn: "#d29922",
      info: "#58a6ff",
    },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    kind: "light",
    syntaxTheme: "github-light-default",
    ansi: {
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
    palette: {
      page: "#ffffff",
      card: "#ffffff",
      sidebar: "#f6f8fa",
      tile: "#f6f8fa",
      hover: "#eef1f4",
      line: "#d1d9e0",
      lineStrong: "#b7c0c9",
      text1: "#1f2328",
      text2: "#59636e",
      text3: "#6e7781",
      text4: "#8c959f",
      accent: "#0969da",
      onAccent: "#ffffff",
      ok: "#1a7f37",
      danger: "#cf222e",
      warn: "#9a6700",
      info: "#0550ae",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    kind: "dark",
    syntaxTheme: "tokyo-night",
    ansi: {
      black: "#363b54",
      red: "#f7768e",
      green: "#73daca",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#787c99",
      brightBlack: "#363b54",
      brightRed: "#f7768e",
      brightGreen: "#73daca",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#acb0d0",
    },
    palette: {
      page: "#1a1b26",
      card: "#1e202e",
      sidebar: "#16161e",
      tile: "#24283b",
      hover: "#292e42",
      line: "rgb(169 177 214 / 10%)",
      lineStrong: "rgb(169 177 214 / 19%)",
      text1: "#c0caf5",
      text2: "#a9b1d6",
      text3: "#7c83a8",
      text4: "#565f89",
      accent: "#7aa2f7",
      onAccent: "#16161e",
      ok: "#9ece6a",
      danger: "#f7768e",
      warn: "#e0af68",
      info: "#7dcfff",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    kind: "dark",
    syntaxTheme: "catppuccin-mocha",
    ansi: {
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#a6adc8",
      brightBlack: "#585b70",
      brightRed: "#f37799",
      brightGreen: "#89d88b",
      brightYellow: "#ebd391",
      brightBlue: "#74a8fc",
      brightMagenta: "#f2aede",
      brightCyan: "#6bd7ca",
      brightWhite: "#bac2de",
    },
    palette: {
      page: "#1e1e2e",
      card: "#232334",
      sidebar: "#181825",
      tile: "#313244",
      hover: "#2c2d3f",
      line: "#313244",
      lineStrong: "#45475a",
      text1: "#cdd6f4",
      text2: "#bac2de",
      text3: "#9399b2",
      text4: "#6c7086",
      accent: "#cba6f7",
      onAccent: "#1e1e2e",
      ok: "#a6e3a1",
      danger: "#f38ba8",
      warn: "#fab387",
      info: "#89dceb",
    },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    kind: "light",
    syntaxTheme: "catppuccin-latte",
    ansi: {
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#de293e",
      brightGreen: "#49af3d",
      brightYellow: "#eea02d",
      brightBlue: "#456eff",
      brightMagenta: "#fe85d8",
      brightCyan: "#2d9fa8",
      brightWhite: "#bcc0cc",
    },
    palette: {
      page: "#eff1f5",
      card: "#f6f7fa",
      sidebar: "#e6e9ef",
      tile: "#dce0e8",
      hover: "#e2e5ec",
      line: "#ccd0da",
      lineStrong: "#bcc0cc",
      text1: "#4c4f69",
      text2: "#5c5f77",
      text3: "#6c6f85",
      text4: "#9ca0b0",
      accent: "#8839ef",
      onAccent: "#ffffff",
      ok: "#40a02b",
      danger: "#d20f39",
      warn: "#fe640b",
      info: "#1e66f5",
    },
  },
] as const satisfies readonly ColorThemeDefinition[];

export type NamedColorThemeId = (typeof COLOR_THEMES)[number]["id"];

/**
 * What the theme picker stores and offers. "system" follows the OS between
 * Solla Light and Solla Dark; every other value is one fixed theme.
 */
export type ThemeChoice = "system" | "solla-light" | "solla-dark" | NamedColorThemeId;

const THEMES_BY_ID: ReadonlyMap<string, ColorThemeDefinition> = new Map(
  COLOR_THEMES.map((theme) => [theme.id, theme]),
);

export function findColorTheme(id: string | null | undefined): ColorThemeDefinition | null {
  return id ? (THEMES_BY_ID.get(id) ?? null) : null;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (
    value === "system" ||
    value === "solla-light" ||
    value === "solla-dark" ||
    (typeof value === "string" && THEMES_BY_ID.has(value))
  );
}

/** Groups for pickers: Solla's own, then the named dark and light themes. */
export const THEME_CHOICE_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly choices: ReadonlyArray<{ readonly value: ThemeChoice; readonly label: string }>;
}> = [
  {
    label: "Solla",
    choices: [
      { value: "system", label: "System" },
      { value: "solla-light", label: "Light" },
      { value: "solla-dark", label: "Dark" },
    ],
  },
  {
    label: "Dark themes",
    choices: COLOR_THEMES.filter((theme) => theme.kind === "dark").map((theme) => ({
      value: theme.id,
      label: theme.label,
    })),
  },
  {
    label: "Light themes",
    choices: COLOR_THEMES.filter((theme) => theme.kind === "light").map((theme) => ({
      value: theme.id,
      label: theme.label,
    })),
  },
];

export function themeChoiceLabel(choice: ThemeChoice): string {
  for (const group of THEME_CHOICE_GROUPS) {
    const match = group.choices.find((entry) => entry.value === choice);
    if (match) return group.label === "Solla" ? `Solla ${match.label}` : match.label;
  }
  return choice;
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Mixes two #rrggbb colors; `amount` is how far toward `other`. */
export function mixHex(color: string, other: string, amount: number): string {
  const a = parseHex(color);
  const b = parseHex(other);
  if (!a || !b) return color;
  return toHex(a.map((channel, index) => channel + (b[index]! - channel) * amount));
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${Math.round(alpha * 100)}%)`;
}

/** WCAG relative luminance of a #rrggbb color. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Every CSS variable a named theme sets on <html>. Covers the primitive
 * surface/text/status scale, the semantic shadcn-style tokens, the accent
 * ramp (the `--gold-*` variables are the theme accent, gold only in Solla),
 * and the sidebar scope that `[data-sidebar-version]` reads.
 */
export function deriveColorThemeVariables(theme: ColorThemeDefinition): Record<string, string> {
  const p = theme.palette;
  const dark = theme.kind === "dark";
  const lighter = (amount: number) => mixHex(p.accent, "#ffffff", amount);
  const darker = (amount: number) => mixHex(p.accent, "#000000", amount);
  const rowHover = withAlpha(p.text1, dark ? 0.05 : 0.04);
  const scrollbar = withAlpha(p.text1, dark ? 0.14 : 0.2);
  return {
    // Primitive scale.
    "--surface-page": p.page,
    "--surface-card": p.card,
    "--surface-row": p.sidebar,
    "--surface-tile": p.tile,
    "--surface-hover": p.hover,
    "--line": p.line,
    "--line-strong": p.lineStrong,
    "--text-1": p.text1,
    "--text-2": p.text2,
    "--text-3": p.text3,
    "--text-4": p.text4,
    "--ok": p.ok,
    "--danger": p.danger,
    "--warn": p.warn,
    // Accent ramp. Light themes read darker steps for text, so the ramp
    // leans toward contrast with the page in both kinds.
    "--gold-300": dark ? lighter(0.45) : lighter(0.3),
    "--gold-400": dark ? lighter(0.22) : lighter(0.12),
    "--gold-500": p.accent,
    "--gold-600": dark ? p.accent : darker(0.12),
    "--gold-700": darker(dark ? 0.2 : 0.3),
    "--gold-500-foreground": p.onAccent,
    "--gold-glow": withAlpha(p.accent, 0.35),
    "--gold-tint": withAlpha(p.accent, dark ? 0.12 : 0.1),
    "--gold-tint-strong": withAlpha(p.accent, dark ? 0.2 : 0.16),
    "--gold-line": withAlpha(p.accent, 0.32),
    "--app-scrollbar-thumb": scrollbar,
    "--app-scrollbar-thumb-hover": withAlpha(p.text1, dark ? 0.22 : 0.3),
    // Semantic tokens.
    "--background": p.page,
    "--app-chrome-background": p.page,
    "--surface-raised": p.tile,
    "--foreground": p.text1,
    "--card": p.card,
    "--card-foreground": p.text1,
    "--popover": p.tile,
    "--popover-foreground": p.text1,
    "--primary": p.accent,
    "--primary-foreground": p.onAccent,
    "--secondary": rowHover,
    "--secondary-foreground": p.text1,
    "--muted": p.tile,
    "--muted-foreground": p.text2,
    "--accent": p.hover,
    "--accent-foreground": p.text1,
    "--destructive": p.danger,
    "--destructive-foreground": p.danger,
    "--border": p.line,
    "--input": p.lineStrong,
    "--ring": p.accent,
    "--info": p.info,
    "--info-foreground": p.info,
    "--success": p.ok,
    "--success-foreground": p.ok,
    "--warning": p.warn,
    "--warning-foreground": p.warn,
    "--sidebar": p.sidebar,
    "--sidebar-foreground": p.text1,
    "--sidebar-muted-foreground": p.text2,
    "--sidebar-control-surface": p.tile,
    "--sidebar-row-hover": rowHover,
    "--sidebar-row-active": withAlpha(p.accent, dark ? 0.2 : 0.16),
    "--sidebar-row-selected": withAlpha(p.accent, dark ? 0.12 : 0.1),
    "--sidebar-border": p.line,
    "--sidebar-stage-fade": p.sidebar,
    // What `[data-sidebar-version]` maps its own tokens onto.
    "--sidebar-scope-background": p.sidebar,
    "--sidebar-scope-card": p.sidebar,
    "--sidebar-scope-accent": p.hover,
    "--sidebar-scope-muted": p.tile,
    "--sidebar-scope-muted-foreground": p.text2,
    "--sidebar-scope-border": p.line,
    "--sidebar-scope-input": p.lineStrong,
    "--sidebar-scope-surface": p.sidebar,
    "--sidebar-scope-control-surface": p.tile,
    "--sidebar-scope-row-hover": rowHover,
    "--sidebar-scope-row-active": withAlpha(p.accent, dark ? 0.2 : 0.16),
    "--sidebar-scope-row-selected": withAlpha(p.accent, dark ? 0.12 : 0.1),
  };
}

/** Everything the pre-paint script in index.html needs, cached at each switch. */
/** xterm colors for a named theme: its own ANSI ramp, with caret and selection in its accent. */
export function colorThemeTerminalColors(theme: ColorThemeDefinition) {
  const { accent, page, text1 } = theme.palette;
  return {
    cursor: accent,
    cursorAccent: page,
    selectionBackground: withAlpha(accent, theme.highContrast ? 0.4 : 0.3),
    selectionInactiveBackground: withAlpha(accent, 0.18),
    scrollbarSliderBackground: withAlpha(text1, 0.12),
    scrollbarSliderHoverBackground: withAlpha(accent, 0.45),
    scrollbarSliderActiveBackground: withAlpha(accent, 0.6),
    ...theme.ansi,
  };
}

export interface ColorThemePaint {
  readonly id: NamedColorThemeId;
  readonly kind: ColorThemeKind;
  readonly background: string;
  readonly foreground: string;
  readonly variables: Record<string, string>;
}

export function colorThemePaint(theme: ColorThemeDefinition): ColorThemePaint {
  return {
    id: theme.id as NamedColorThemeId,
    kind: theme.kind,
    background: theme.palette.page,
    foreground: theme.palette.text1,
    variables: deriveColorThemeVariables(theme),
  };
}
