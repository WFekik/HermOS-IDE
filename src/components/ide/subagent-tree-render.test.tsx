// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageRenderer } from "@/components/ide/message-renderer";
import type { UIMessage } from "@/stores/app-store";

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("@/components/ide/code-block", () => ({
  CodeBlock: ({ language, value }: { language?: string; value: string }) => (
    <pre data-testid="code-mock" data-language={language}>
      {value}
    </pre>
  ),
}));

afterEach(cleanup);

const BLOB =
  "Project Structure . |-- dist/ # compiled output |-- node_modules/ # dependencies |-- src/ # source code |-- index.js # CLI entry |-- tools/ # modules |-- fileTools.js # file ops |-- commandRunner.js # shell |-- package.json # manifest |-- README.md # usage";

function subagentMessage(content: string): UIMessage {
  return {
    id: "sa-msg-1",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    liveToolCalls: [],
    segments: [],
  };
}

describe("subagent transcript tree rendering", () => {
  it("renders an inline directory blob as a tree code block", () => {
    render(<MessageRenderer message={subagentMessage(BLOB)} variant="subagent" />);
    const block = screen.getByTestId("code-mock");
    expect(block.getAttribute("data-language")).toBe("tree");
    expect(block.textContent).toContain("|-- dist/");
  });

  it("routes a language-less fenced tree to the code block with newlines intact", () => {
    const content = "Structure:\n```\nsrc/\n├── main.tsx\n└── App.tsx\n```\nDone.";
    render(<MessageRenderer message={subagentMessage(content)} variant="subagent" />);
    const block = screen.getByTestId("code-mock");
    expect(block.textContent).toContain("src/\n├── main.tsx\n└── App.tsx");
    expect(block.textContent).not.toContain("main.tsx └── App.tsx");
  });
});
