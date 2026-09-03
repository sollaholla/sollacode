import { describe, expect, it } from "vite-plus/test";

import {
  applyWorkCardEdges,
  deriveWorkCardEdges,
  isWorkCardRow,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

function row(kind: string, id: string, role?: "user" | "assistant"): MessagesTimelineRow {
  const base = { kind, id, createdAt: "2026-09-02T00:00:00.000Z" };
  return (kind === "message"
    ? { ...base, message: { role, id } }
    : base) as unknown as MessagesTimelineRow;
}

describe("isWorkCardRow", () => {
  it("boxes the agent's side of the conversation only", () => {
    expect(isWorkCardRow(row("message", "a", "assistant"))).toBe(true);
    expect(isWorkCardRow(row("work", "w"))).toBe(true);
    expect(isWorkCardRow(row("work-toggle", "t"))).toBe(true);
    expect(isWorkCardRow(row("working", "live"))).toBe(true);
    expect(isWorkCardRow(row("message", "u", "user"))).toBe(false);
    expect(isWorkCardRow(row("provider-transition", "p"))).toBe(false);
    expect(isWorkCardRow(row("turn-fold", "f"))).toBe(false);
  });
});

describe("deriveWorkCardEdges", () => {
  it("draws one box per assistant turn, split by the user's messages", () => {
    const edges = deriveWorkCardEdges([
      row("message", "u1", "user"),
      row("message", "a1", "assistant"),
      row("work", "w1"),
      row("work-toggle", "t1"),
      row("message", "a2", "assistant"),
      row("message", "u2", "user"),
      row("message", "a3", "assistant"),
      row("working", "live"),
    ]);
    expect(edges.get("u1")).toBeUndefined();
    expect(edges.get("a1")).toBe("start");
    expect(edges.get("w1")).toBe("middle");
    expect(edges.get("t1")).toBe("middle");
    expect(edges.get("a2")).toBe("end");
    expect(edges.get("u2")).toBeUndefined();
    expect(edges.get("a3")).toBe("start");
    expect(edges.get("live")).toBe("end");
  });

  it("gives a lone reply both edges", () => {
    const edges = deriveWorkCardEdges([
      row("message", "u1", "user"),
      row("message", "a1", "assistant"),
      row("provider-transition", "p1"),
      row("work", "w1"),
    ]);
    expect(edges.get("a1")).toBe("solo");
    expect(edges.get("p1")).toBeUndefined();
    expect(edges.get("w1")).toBe("solo");
  });

  it("handles an empty timeline", () => {
    expect(deriveWorkCardEdges([]).size).toBe(0);
  });
});

describe("applyWorkCardEdges", () => {
  it("stamps edges onto the rows and keeps identity for rows whose edge is unchanged", () => {
    const rows = [
      row("message", "u1", "user"),
      row("message", "a1", "assistant"),
      row("work", "w1"),
    ];
    const first = applyWorkCardEdges(rows);
    expect(first[0]).toBe(rows[0]);
    expect(first[1]?.cardEdge).toBe("start");
    expect(first[2]?.cardEdge).toBe("end");

    const second = applyWorkCardEdges(rows);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);

    const grown = applyWorkCardEdges([...rows, row("working", "live")]);
    expect(grown[1]).toBe(first[1]);
    expect(grown[2]).not.toBe(first[2]);
    expect(grown[2]?.cardEdge).toBe("middle");
    expect(grown[3]?.cardEdge).toBe("end");
  });
});
