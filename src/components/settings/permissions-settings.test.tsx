// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PermissionsSettings } from "@/components/settings/permissions-settings";
import { apiGet } from "@/lib/api-client";
import {
  DEFAULT_PERMISSIONS,
  PERMISSION_ACTIONS,
  evaluatePermission,
  evaluateOutsideWorkspaceCommand,
  type PermissionsConfig,
} from "@/lib/permissions-core";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

const mockApiGet = vi.mocked(apiGet);

const MODE_LABEL: Record<string, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PermissionsSettings />
    </QueryClientProvider>,
  );
}

/** The mode the settings table highlights for an action row. */
function displayedMode(action: string): string | null {
  const row = screen.getByText(action).closest("tr");
  if (!row) return null;
  const pressed = row.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
  return pressed?.textContent ?? null;
}

describe("Permissions settings — the table never lies", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function assertTableMatchesEngine(config: PermissionsConfig) {
    mockApiGet.mockResolvedValue({ config } as never);
    renderSettings();
    await waitFor(() => expect(screen.getByText("file.write")).toBeTruthy());

    for (const action of PERMISSION_ACTIONS) {
      // The outside-workspace row follows the `command.run: deny` kill switch,
      // so it is judged by the same function the engine uses.
      const expected = MODE_LABEL[
        action === "command.outside_workspace"
          ? evaluateOutsideWorkspaceCommand(config)
          : evaluatePermission(config, action)
      ];
      expect(displayedMode(action), `displayed mode for ${action}`).toBe(expected);
    }
  }

  it("shows the effective mode for the default config", async () => {
    await assertTableMatchesEngine({
      ...DEFAULT_PERMISSIONS,
      rules: DEFAULT_PERMISSIONS.rules.map((r) => ({ ...r })),
    });
  });

  it("shows the effective mode with the auto-allow switch off", async () => {
    await assertTableMatchesEngine({
      ...DEFAULT_PERMISSIONS,
      autoAllowReadonly: false,
      rules: DEFAULT_PERMISSIONS.rules.map((r) => ({ ...r })),
    });
  });

  it("shows the effective mode for a hand-edited config", async () => {
    await assertTableMatchesEngine({
      rules: [{ action: "command.run", mode: "deny" }],
      autoAllowReadonly: true,
    });
  });

  it("never shows Ask for an action the engine allows by default", async () => {
    mockApiGet.mockResolvedValue({ config: DEFAULT_PERMISSIONS } as never);
    renderSettings();
    await waitFor(() => expect(screen.getByText("file.write")).toBeTruthy());

    // The subagent orchestration actions are allowed by default — the table
    // must say so instead of the engine's hidden fallback.
    expect(displayedMode("subagent.get")).toBe("Allow");
    expect(displayedMode("subagent.message")).toBe("Allow");
    expect(displayedMode("subagent.spawn")).toBe("Allow");
  });
});
