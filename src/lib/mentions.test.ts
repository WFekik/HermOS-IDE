import { describe, it, expect } from "vitest";
import { parseMentions } from "./mentions";

describe("Multi-word Quoted Mentions Parser", () => {
  it("parses single-word unquoted agent mention", () => {
    const mentions = parseMentions("Hello @agent:Doc how are you?");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("Doc");
  });

  it("parses double-quoted multi-word agent mention", () => {
    const mentions = parseMentions('Switching to @agent:"Doc Writer" persona');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("Doc Writer");
  });

  it("parses single-quoted multi-word agent mention", () => {
    const mentions = parseMentions("Ask @agent:'Code Architect' for architecture review");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("Code Architect");
  });

  it("keeps matching a double-quoted mention while the closing quote is being typed", () => {
    const mentions = parseMentions('Switch to @agent:"Doc Writ');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("agent");
    expect(mentions[0].id).toBe("Doc Writ");
  });

  it("keeps matching a single-quoted mention while the closing quote is being typed", () => {
    const mentions = parseMentions("Ask @agent:'Code Arch");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].id).toBe("Code Arch");
  });

  it("returns empty id (no mention) for a bare open quote", () => {
    const mentions = parseMentions('Switch to @agent:"');
    expect(mentions).toHaveLength(0);
  });
});
