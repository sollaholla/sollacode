import type { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

export type RuntimeModeTone = "default" | "danger";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon; tone: RuntimeModeTone }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
    tone: "default",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
    tone: "default",
  },
  auto: {
    label: "Auto",
    description: "An AI reviewer approves routine actions; risky ones still ask.",
    icon: SparklesIcon,
    tone: "default",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
    tone: "danger",
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export const runtimeModeDangerClasses = {
  control: "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
  item: "text-destructive data-selected:bg-destructive/12 data-highlighted:bg-destructive/10 data-highlighted:text-destructive",
  label: "text-destructive",
  icon: "text-destructive/80",
  description: "text-destructive/75",
  compactItem:
    "text-destructive data-checked:bg-destructive/12 data-highlighted:bg-destructive/10 data-highlighted:text-destructive",
} as const;
