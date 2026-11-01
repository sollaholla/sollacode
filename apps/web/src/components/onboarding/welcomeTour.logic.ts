/** The ideas the tour teaches, one per step, in the order someone meets them. */
export const WELCOME_TOUR_STEPS = [
  {
    id: "project",
    title: "Start with a folder",
    body: "Pick a folder on your computer. That's your project. The AI works on the files inside.",
  },
  {
    id: "ask",
    title: "Ask in plain words",
    body: "Say what you want changed. The AI does it and shows you the result.",
  },
  {
    id: "model",
    title: "Choose your AI",
    body: "Use the icon in the message box to switch to a different AI.",
  },
  {
    id: "threads",
    title: "Each task is a thread",
    body: "A thread is one conversation. Settle it when it's done and it moves out of the way.",
  },
  {
    id: "search",
    title: "Find anything",
    body: "Press {shortcut} to search your past chats and settings.",
    touchBody: "Open the menu and tap Search to find your past chats and settings.",
  },
  {
    id: "agents",
    title: "Agents work on their own",
    body: "An agent is an AI helper for repeat jobs. It tells you when it needs you.",
  },
] as const;

/** The search shortcut as this computer spells it. */
export function searchShortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

export type WelcomeTourStepId = (typeof WELCOME_TOUR_STEPS)[number]["id"];

/** Where someone stopped, so closing the app mid-tour resumes at the same spot. */
export type WelcomeProgress =
  | { readonly screen: "preferences" }
  | { readonly screen: "tour"; readonly step: number };

const WELCOME_PROGRESS_KEY = "solla:welcome-progress:v1";

export function parseWelcomeProgress(raw: string | null): WelcomeProgress {
  const match = raw === null ? null : /^tour:(\d{1,2})$/.exec(raw);
  if (match === null) return { screen: "preferences" };
  const step = Number(match[1]);
  return step < WELCOME_TOUR_STEPS.length ? { screen: "tour", step } : { screen: "preferences" };
}

export function readWelcomeProgress(): WelcomeProgress {
  try {
    return parseWelcomeProgress(window.localStorage.getItem(WELCOME_PROGRESS_KEY));
  } catch {
    return { screen: "preferences" };
  }
}

export function saveWelcomeProgress(progress: WelcomeProgress | null): void {
  try {
    if (progress === null) window.localStorage.removeItem(WELCOME_PROGRESS_KEY);
    else if (progress.screen === "tour") {
      window.localStorage.setItem(WELCOME_PROGRESS_KEY, `tour:${progress.step}`);
    } else window.localStorage.setItem(WELCOME_PROGRESS_KEY, "preferences");
  } catch {
    // Resuming is a convenience; a private window just starts over.
  }
}
