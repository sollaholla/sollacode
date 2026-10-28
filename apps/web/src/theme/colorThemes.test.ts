import { describe, expect, it } from "vite-plus/test";

import { resolveDiffThemeName } from "../lib/diffRendering";
import {
  COLOR_THEMES,
  THEME_CHOICE_GROUPS,
  colorThemePaint,
  colorThemeTerminalColors,
  contrastRatio,
  deriveColorThemeVariables,
  findColorTheme,
  isThemeChoice,
  themeChoiceLabel,
  type ColorThemeDefinition,
} from "./colorThemes";

describe("named color themes", () => {
  it("have unique ids and appear once in the picker", () => {
    const ids = COLOR_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);

    const pickerValues = THEME_CHOICE_GROUPS.flatMap((group) =>
      group.choices.map((choice) => choice.value),
    );
    expect(new Set(pickerValues).size).toBe(pickerValues.length);
    for (const id of ["system", "solla-light", "solla-dark", ...ids]) {
      expect(pickerValues).toContain(id);
    }
  });

  it.each<ColorThemeDefinition>(COLOR_THEMES)("$label keeps text readable", (theme) => {
    const { palette } = theme;
    const bodyText = theme.highContrast ? 15 : 7;
    expect(contrastRatio(palette.text1, palette.page)).toBeGreaterThanOrEqual(bodyText);
    expect(contrastRatio(palette.text1, palette.card)).toBeGreaterThanOrEqual(bodyText);
    expect(contrastRatio(palette.text2, palette.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(COLOR_THEMES)("$label paints every token Solla's own themes define", (theme) => {
    const variables = deriveColorThemeVariables(theme);
    for (const name of [
      "--background",
      "--foreground",
      "--card",
      "--popover",
      "--primary",
      "--primary-foreground",
      "--muted-foreground",
      "--border",
      "--ring",
      "--destructive",
      "--sidebar",
      "--gold-500",
      "--gold-500-foreground",
      "--sidebar-scope-surface",
      "--sidebar-scope-muted-foreground",
    ]) {
      expect(variables[name], name).toBeTruthy();
    }
    expect(variables["--background"]).toBe(theme.palette.page);
    expect(variables["--primary"]).toBe(theme.palette.accent);
  });

  it("caches a paint the pre-paint script can apply without the bundle", () => {
    const dracula = findColorTheme("dracula");
    expect(dracula).not.toBeNull();
    const paint = colorThemePaint(dracula!);
    expect(paint).toMatchObject({
      id: "dracula",
      kind: "dark",
      background: dracula!.palette.page,
      foreground: dracula!.palette.text1,
    });
    expect(JSON.parse(JSON.stringify(paint))).toEqual(paint);
  });

  it("gives the terminal the theme's own ANSI colors and a see-through selection", () => {
    const nord = findColorTheme("nord")!;
    const colors = colorThemeTerminalColors(nord);
    expect(colors.red).toBe(nord.ansi.red);
    expect(colors.brightWhite).toBe(nord.ansi.brightWhite);
    expect(colors.cursor).toBe(nord.palette.accent);
    expect(colors.selectionBackground).toMatch(/^rgb\(\d+ \d+ \d+ \/ \d+%\)$/);
  });

  it("highlights code with the named theme's syntax colors", () => {
    const dracula = findColorTheme("dracula");
    expect(resolveDiffThemeName("dark", dracula)).toBe("dracula");
    expect(resolveDiffThemeName("dark", null)).toBe("pierre-dark");
    expect(resolveDiffThemeName("light", null)).toBe("pierre-light");
  });

  it("validates and labels picker values", () => {
    expect(isThemeChoice("solla-dark")).toBe(true);
    expect(isThemeChoice("dracula")).toBe(true);
    expect(isThemeChoice("not-a-theme")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
    expect(themeChoiceLabel("system")).toBe("Solla System");
    expect(themeChoiceLabel("dracula")).toBe("Dracula");
    expect(findColorTheme("not-a-theme")).toBeNull();
  });
});
