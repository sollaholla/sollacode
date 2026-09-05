import threads from "../../captures/threads-source.json" with { type: "json" };
import providers from "../../captures/providers-source.json" with { type: "json" };
import artifact from "../../captures/artifact-source.json" with { type: "json" };
import terminals from "../../captures/terminals-source.json" with { type: "json" };
import agents from "../../captures/agents-source.json" with { type: "json" };

export interface FilmAction {
  at: number;
  x: number;
  y: number;
  name: string;
  kind?: "click" | "type";
}

export interface FilmScene {
  id: string;
  eyebrow: string;
  title: string[];
  description: string;
  source?: string;
  sourceStart?: number;
  actions?: FilmAction[];
}

export const FPS = 30;
export const SCENE_SECONDS = 8;
export const SCENES: FilmScene[] = [
  {
    id: "opening",
    eyebrow: "SOLLA CODE",
    title: ["Make room", "for the work."],
    description: "Your agents. Your tools. One workspace.",
  },
  {
    id: "threads",
    eyebrow: "01 / YOUR PROJECTS",
    title: ["Every thread.", "In its place."],
    description: "A workspace with room for everything you’re building.",
    source: "threads",
    sourceStart: 0,
    actions: threads.actions,
  },
  {
    id: "providers",
    eyebrow: "02 / YOUR INTELLIGENCE",
    title: ["Choose your", "point of view."],
    description: "Bring the coding providers you already use.",
    source: "providers",
    sourceStart: 0,
    actions: providers.actions,
  },
  {
    id: "terminals",
    eyebrow: "03 / YOUR TOOLS",
    title: ["Stay close", "to the code."],
    description: "Real commands. Split terminals. Results in view.",
    source: "terminals",
    sourceStart: 0,
    actions: terminals.actions,
  },
  {
    id: "artifacts",
    eyebrow: "04 / YOUR RESULTS",
    title: ["From an idea.", "To something", "you can open."],
    description: "Keep the result beside the conversation that shaped it.",
    source: "artifact",
    sourceStart: 0,
    actions: artifact.actions,
  },
  {
    id: "agents",
    eyebrow: "05 / YOUR TEAM",
    title: ["A team", "shaped", "by you."],
    description: "Give each agent a purpose and a way of working.",
    source: "agents",
    sourceStart: 0,
    actions: agents.actions,
  },
  {
    id: "voice",
    eyebrow: "06 / YOUR VOICE",
    title: ["Start with", "a thought."],
    description: "Your orchestrator keeps the workspace within reach.",
    source: "voice",
    sourceStart: 0,
  },
  {
    id: "workspace",
    eyebrow: "07 / YOUR WORKSPACE",
    title: ["The context", "stays with", "the work."],
    description: "Projects, conversations, and the next step. Together.",
    source: "workspace",
    sourceStart: 0,
  },
  {
    id: "closing",
    eyebrow: "SOLLA CODE",
    title: ["Build something", "that matters."],
    description: "$10 / month     or     $120 / year",
  },
];
