import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_RULES, composeSystemPrompt } from "./system-prompt";

describe("system prompt composition", () => {
  const parts = {
    base: "BASE",
    workspaceRules: "\n\n## Workspace rules\nRULES",
    toolSection: "\n\n## Mode: Agent\nTOOLS",
    capabilities: "\n\n## Capabilities\nCAPS",
    environment: "\n\n## Build Environment\nENV",
    discovery: "\n\n## Integrations\nDISC",
    mission: "\n\n## Original Request (Mission)\nMISSION",
    responseRules: "\n\n## Response Rules\nLANG",
  };

  it("keeps the baseline even when the user set their own instructions", () => {
    const prompt = composeSystemPrompt({ ...parts, userInstructions: "Always answer in French." });
    expect(prompt).toContain("BASE");
    expect(prompt).toContain("Always answer in French.");
  });

  it("places the user's instructions after the context blocks so they carry the weight", () => {
    const prompt = composeSystemPrompt({ ...parts, userInstructions: "USER" });
    expect(prompt.indexOf("USER")).toBeGreaterThan(prompt.indexOf("MISSION"));
    expect(prompt.indexOf("USER")).toBeLessThan(prompt.indexOf("LANG"));
    expect(prompt).toContain("they override the defaults above where they conflict");
  });

  it("keeps the response rules last — they are mechanical", () => {
    const prompt = composeSystemPrompt({ ...parts, userInstructions: "USER" });
    expect(prompt.trimEnd().endsWith("LANG")).toBe(true);
  });

  it("omits the user block when there are no user instructions", () => {
    const prompt = composeSystemPrompt(parts);
    expect(prompt).not.toContain("User instructions");
  });

  it("reduces to the base and the tool section in minimal mode", () => {
    const prompt = composeSystemPrompt({ ...parts, userInstructions: "USER" }, true);
    expect(prompt).toBe("BASE\n\n## Mode: Agent\nTOOLS");
  });

  it("states the subagent and reporting rules in the baseline", () => {
    // The agent must end its turn while workers run and keep the chat short.
    expect(BASE_SYSTEM_RULES).toContain("Prefer ending your turn while the workers run");
    expect(BASE_SYSTEM_RULES).toContain("never poll or loop-wait");
    expect(BASE_SYSTEM_RULES).toContain("create_artifact");
    expect(BASE_SYSTEM_RULES).toContain("résumé");
  });

  it("stays framework-agnostic", () => {
    expect(BASE_SYSTEM_RULES).not.toMatch(/Next\.js|React|Vite|Django/i);
  });
});
