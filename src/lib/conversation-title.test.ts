import { describe, it, expect } from "vitest";
import {
  UNTITLED_CONVERSATION_TITLE,
  displayConversationTitle,
  cleanHeuristicTitle,
} from "./conversation-title";

describe("conversation-title", () => {
  describe("displayConversationTitle", () => {
    const translate = (key: string) => (key === "new_conversation" ? "New Conversation" : key);

    it("translates untitled legacy titles regardless of casing", () => {
      expect(displayConversationTitle("New conversation", translate)).toBe("New Conversation");
      expect(displayConversationTitle("New Conversation", translate)).toBe("New Conversation");
      expect(displayConversationTitle("new conversation", translate)).toBe("New Conversation");
      expect(displayConversationTitle("", translate)).toBe("New Conversation");
      expect(displayConversationTitle(null, translate)).toBe("New Conversation");
      expect(displayConversationTitle(undefined, translate)).toBe("New Conversation");
    });

    it("preserves custom titles as-is", () => {
      expect(displayConversationTitle("My Cool Chat", translate)).toBe("My Cool Chat");
      expect(displayConversationTitle("Fix Local Models", translate)).toBe("Fix Local Models");
    });
  });

  describe("cleanHeuristicTitle", () => {
    it("cleans greetings, filler, and conversational preambles", () => {
      expect(cleanHeuristicTitle("now i wanna fix the local models when i use them they dont auto compact")).toBe(
        "Fix The Local Models",
      );
      expect(cleanHeuristicTitle("Can you help me design a landing page for my SaaS?")).toBe(
        "Design A Landing Page",
      );
      expect(cleanHeuristicTitle("hey hermos, why is API auth failing with 401?")).toBe(
        "Why Is API Auth Failing",
      );
    });

    it("strips slash commands, file mentions, and code blocks", () => {
      expect(cleanHeuristicTitle("/agent write unit tests for auth service")).toBe(
        "Write Unit Tests For Auth",
      );
      expect(
        cleanHeuristicTitle("```python\nprint(1)\n``` How to debug memory leak in python?"),
      ).toBe("Debug Memory Leak In Python");
      expect(cleanHeuristicTitle("@file:src/index.ts can you inspect auth errors?")).toBe(
        "Inspect Auth Errors",
      );
    });

    it("strips trailing prepositions, conjunctions, and articles", () => {
      expect(cleanHeuristicTitle("Investigate memory consumption in")).toBe("Investigate Memory Consumption");
      expect(cleanHeuristicTitle("How to deploy Next.js with")).toBe("Deploy Next.js");
    });

    it("handles non-English Unicode characters cleanly", () => {
      const arabic = cleanHeuristicTitle("مرحبا كيف حالك اليوم");
      expect(arabic.length).toBeGreaterThan(0);
      expect(arabic).not.toBe("Chat");
    });

    it("falls back to 'Chat' for empty or whitespace-only inputs", () => {
      expect(cleanHeuristicTitle("")).toBe("Chat");
      expect(cleanHeuristicTitle("   \n\t  ")).toBe("Chat");
      expect(cleanHeuristicTitle("```\n```")).toBe("Chat");
    });
  });
});
