/**
 * A reconstruction of the Solla Code desktop shell.
 *
 * Geometry and colour are taken from the real client rather than eyeballed:
 * the sidebar is 255px, thread rows are 36px tall at an 8px radius with 10px of
 * left padding, section headers are 12px/500, and the orchestrator row is 32px.
 * Colours come from `theme/tokens.css`, which carries the web client's own dark
 * token values.
 *
 * This is a reconstruction for documentation media, not a screen recording and
 * not the shipped components.
 */
import type { CSSProperties, ReactNode } from "react";

import {
  ArrowUpIcon,
  AudioLinesIcon,
  BotIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
} from "./icons";

export const SIDEBAR_WIDTH = 255;

const muted = "var(--sidebar-muted-foreground)";

export function AppWindow({
  children,
  style,
}: {
  readonly children: ReactNode;
  readonly style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 26,
        background: "#050505",
        ...style,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--background)",
          boxShadow: "0 40px 120px rgba(0,0,0,0.65)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Row({
  children,
  active = false,
  height = 36,
  paddingLeft = 10,
  style,
}: {
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly height?: number;
  readonly paddingLeft?: number;
  readonly style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height,
        paddingLeft,
        paddingRight: 8,
        borderRadius: 8,
        fontSize: 14,
        color: "var(--sidebar-foreground)",
        background: active ? "var(--sidebar-row-active)" : "transparent",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  label,
  expanded,
  count,
  paddingLeft = 10,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly count?: number;
  readonly paddingLeft?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 18,
        marginBottom: 5,
        paddingLeft,
        // Reads as a header: same size as the rows beneath it, distinguished by
        // weight and colour rather than by being smaller than its own contents.
        fontSize: 14,
        fontWeight: 600,
        color: "color-mix(in srgb, var(--sidebar-foreground) 75%, transparent)",
      }}
    >
      <span>{expanded || count === undefined ? label : `${label} (${count})`}</span>
      <ChevronDownIcon
        size={14}
        style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "none" }}
      />
    </div>
  );
}

export interface ThreadRowData {
  readonly title: string;
  readonly project: string;
  readonly age: string;
  readonly active?: boolean;
  readonly working?: boolean;
}

export function Sidebar({
  agentsExpanded,
  threadsExpanded,
  threads,
  agents,
  revealCount,
  orchestratorActive = false,
}: {
  readonly agentsExpanded: boolean;
  readonly threadsExpanded: boolean;
  readonly threads: readonly ThreadRowData[];
  readonly agents: readonly { readonly name: string; readonly status: "running" | "idle" }[];
  readonly revealCount: number;
  readonly orchestratorActive?: boolean;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        background: "var(--sidebar)",
        borderRight: "1px solid var(--sidebar-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 22,
            height: 22,
            borderRadius: 7,
            background: "linear-gradient(150deg,#e8c877,#c89b3c 55%,#8d6a22)",
            color: "#191308",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          S
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.1 }}>Solla Code</span>
      </div>

      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        <Row height={32}>
          <SearchIcon size={16} color={muted} />
          <span style={{ flex: 1 }}>Search</span>
          <span
            style={{
              fontSize: 10,
              color: muted,
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            ⌘K
          </span>
        </Row>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Row height={32} style={{ flex: 1 }}>
            <FolderIcon size={16} color={muted} />
            <span style={{ flex: 1 }}>All projects</span>
            <ChevronDownIcon size={14} color={muted} />
          </Row>
          <SquarePenIcon size={15} color={muted} />
        </div>
        <Row height={32} active={orchestratorActive}>
          <AudioLinesIcon size={16} color={orchestratorActive ? "var(--brand-gold)" : muted} />
          <span style={{ flex: 1 }}>Orchestrator</span>
          {orchestratorActive ? (
            <span
              style={{ width: 6, height: 6, borderRadius: 999, background: "var(--brand-gold)" }}
            />
          ) : null}
        </Row>
      </div>

      <div style={{ padding: "6px 8px 0" }}>
        <SectionHeader label="Agents" expanded={agentsExpanded} />
        {agentsExpanded ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingLeft: 8,
                paddingRight: 4,
                fontSize: 11,
                color: muted,
                opacity: 0.75,
              }}
            >
              <span>Soloman&rsquo;s MacBook Pro</span>
              <PlusIcon size={13} color={muted} />
            </div>
            {agents.map((agent) => (
              <Row key={agent.name}>
                <BotIcon size={16} color={muted} />
                <span style={{ flex: 1 }}>{agent.name}</span>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: agent.status === "running" ? "#34d399" : "var(--muted-foreground)",
                  }}
                />
              </Row>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ padding: "8px 8px 0", flex: 1, minHeight: 0 }}>
        <SectionHeader label="Threads" expanded={threadsExpanded} count={threads.length} />
        {threadsExpanded ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {threads.slice(0, revealCount).map((thread) => (
              <div
                key={thread.title}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: thread.active ? "var(--sidebar-row-active)" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      flexShrink: 0,
                      background: thread.working ? "#34d399" : "transparent",
                      border: thread.working ? "none" : "1px solid var(--border)",
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: thread.active ? "var(--foreground)" : "var(--sidebar-foreground)",
                    }}
                  >
                    {thread.title}
                  </span>
                  <span style={{ fontSize: 11, color: muted, flexShrink: 0 }}>{thread.age}</span>
                </div>
                <span style={{ paddingLeft: 12, fontSize: 11, color: muted, opacity: 0.8 }}>
                  {thread.project}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ padding: "0 8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        <Row height={32}>
          <DownloadIcon size={16} color={muted} />
          <span style={{ flex: 1 }}>Background tasks</span>
          <span style={{ fontSize: 11, color: muted }}>0</span>
        </Row>
        <Row height={32}>
          <SettingsIcon size={16} color={muted} />
          <span style={{ flex: 1 }}>Settings</span>
        </Row>
      </div>
    </aside>
  );
}

export function MainHeader({
  project,
  title,
}: {
  readonly project: string;
  readonly title: string;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 44,
        padding: "0 14px",
        flexShrink: 0,
        fontSize: 13,
      }}
    >
      <FolderIcon size={14} color={muted} />
      <span style={{ color: muted }}>{project}</span>
      <span style={{ color: muted, opacity: 0.5 }}>/</span>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <div style={{ flex: 1 }} />
      {["Actions", "Open"].map((label) => (
        <span
          key={label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 24,
            padding: "0 9px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--foreground)",
          }}
        >
          {label}
          <ChevronDownIcon size={11} color={muted} />
        </span>
      ))}
      <PanelIcon size={15} color={muted} style={{ marginLeft: 4 }} />
    </header>
  );
}

export function Composer({
  placeholder = "Ask anything, @tag files/folders, $use skills, or / for commands",
}) {
  return (
    <div
      style={{
        margin: "0 14px 14px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "12px 12px 9px",
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 13, color: muted, opacity: 0.75 }}>{placeholder}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 14 }}>
        <TerminalIcon size={15} color={muted} />
        <BotIcon size={15} color={muted} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: muted }}>Max · 1M</span>
        <div
          style={{
            display: "grid",
            placeItems: "center",
            width: 24,
            height: 24,
            borderRadius: 999,
            background: "var(--primary)",
          }}
        >
          <ArrowUpIcon size={13} color="#fff" />
        </div>
      </div>
    </div>
  );
}
