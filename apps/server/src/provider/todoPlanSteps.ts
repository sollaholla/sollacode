/**
 * Plan steps derived from a provider's todo-list tool call.
 *
 * Claude Code's `TodoWrite` and OpenCode's `todowrite` share one input shape —
 * `{ todos: [{ content, status, priority? }] }` — and both feed the Plan tab
 * through `turn.plan.updated`. Kept provider-neutral so every adapter that
 * sees such a tool call renders the same plan.
 */

export type TodoPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export function isTodoWriteTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

export function planStepsFromTodoInput(input: unknown): TodoPlanStep[] | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const todos = (input as { readonly todos?: unknown }).todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  const steps = todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? ("completed" as const)
          : todo.status === "in_progress"
            ? ("inProgress" as const)
            : ("pending" as const),
    }));
  return steps.length > 0 ? steps : null;
}
