import type { ComponentType } from "react";
import { Bot, Compass, MessageSquare } from "lucide-react";
import type { AgentMode } from "@/lib/types";

/** Single source of truth for the 3 conversation modes (agent/chat/architect) with icons and copy. */

export interface AgentModeMeta {
  value: AgentMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  description: string;
}

export const AGENT_MODES: readonly AgentModeMeta[] = [
  {
    value: "agent",
    label: "Agent",
    icon: Bot,
    description: "Autonomous — reads, writes code, runs commands & tools",
  },
  {
    value: "chat",
    label: "Chat",
    icon: MessageSquare,
    description: "Conversation only — Q&A & code snippets (tool calls disabled)",
  },
  {
    value: "architect",
    label: "Architect",
    icon: Compass,
    description: "Planning & Design — read-only codebase inspection & plans",
  },
];

export const AGENT_MODES_BY_VALUE: Record<AgentMode, AgentModeMeta> =
  Object.fromEntries(AGENT_MODES.map((m) => [m.value, m])) as Record<
    AgentMode,
    AgentModeMeta
  >;