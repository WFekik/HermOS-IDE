// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Providers } from "@/components/providers";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/components/theme/theme-provider";
import * as fs from "fs";
import * as path from "path";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

function TestConsumer() {
  const queryClient = useQueryClient();
  const themeContext = useTheme();

  return (
    <div>
      <span data-testid="has-query-client">{queryClient ? "yes" : "no"}</span>
      <span data-testid="theme-value">{themeContext.theme ?? "undefined"}</span>
      <span data-testid="child-text">Child Content Rendered</span>
    </div>
  );
}

describe("Providers Component (Milestone 1)", () => {
  it("renders children cleanly without SessionProvider wrapper or auth context requirements", () => {
    render(
      <Providers>
        <TestConsumer />
      </Providers>
    );

    expect(screen.getByTestId("child-text").textContent).toBe("Child Content Rendered");
    expect(screen.getByTestId("has-query-client").textContent).toBe("yes");
  });

  it("statically verifies that SessionProvider and next-auth are completely removed from providers.tsx", () => {
    const providersPath = path.resolve(__dirname, "providers.tsx");
    const content = fs.readFileSync(providersPath, "utf-8");

    expect(content).not.toContain("SessionProvider");
    expect(content).not.toContain("next-auth");
    expect(content).not.toContain("getServerSession");
  });
});
