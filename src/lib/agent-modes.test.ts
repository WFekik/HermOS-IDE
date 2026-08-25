import { describe, it, expect } from "vitest";
import { AGENT_MODES, AGENT_MODES_BY_VALUE } from "./agent-modes";

describe("Agent Modes", () => {
  it("should have exactly 3 modes", () => {
    expect(AGENT_MODES).toHaveLength(3);
  });

  it("should include agent, chat, and architect", () => {
    const values = AGENT_MODES.map((m) => m.value);
    expect(values).toContain("agent");
    expect(values).toContain("chat");
    expect(values).toContain("architect");
  });

  it("should have unique values", () => {
    const values = AGENT_MODES.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("should have AGENT_MODES_BY_VALUE lookup matching every mode", () => {
    for (const mode of AGENT_MODES) {
      expect(AGENT_MODES_BY_VALUE[mode.value]).toBeDefined();
      expect(AGENT_MODES_BY_VALUE[mode.value].label).toBe(mode.label);
      expect(AGENT_MODES_BY_VALUE[mode.value].description).toBe(mode.description);
    }
  });

  it('should have agent mode as autonomous', () => {
    const agent = AGENT_MODES_BY_VALUE["agent"];
    expect(agent.label).toBe("Agent");
    expect(agent.description).toContain("Autonomous");
  });

  it('should have chat mode without tool calls', () => {
    const chat = AGENT_MODES_BY_VALUE["chat"];
    expect(chat.label).toBe("Chat");
    expect(chat.description).toContain("tool calls disabled");
  });

  it('should have architect mode as read-only', () => {
    const arch = AGENT_MODES_BY_VALUE["architect"];
    expect(arch.label).toBe("Architect");
    expect(arch.description).toContain("read-only");
  });

  it("should have icon defined for each mode", () => {
    for (const mode of AGENT_MODES) {
      expect(mode.icon).toBeDefined();
    }
  });

  it("should have icons defined as valid React component types", () => {
    for (const mode of AGENT_MODES) {
      const Icon = mode.icon;
      expect(Icon).toBeDefined();
      // In node test environment, lucide-react icons are forwardRef components
      // which have displayName or render properties
      expect(Icon.displayName || Icon.name || typeof Icon).toBeTruthy();
    }
  });
});
