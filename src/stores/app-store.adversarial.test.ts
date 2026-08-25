import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { apiGet, apiPost } from "@/lib/api-client";
import type { UserDTO } from "@/lib/types";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = "ApiRequestError";
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);

describe("Milestone 1 — Store Auth & Hydration Adversarial Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Initial Auth State", () => {
    it("has non-null currentUser with desktop-user defaults", () => {
      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.id).toBe("desktop-user");
      expect(state.currentUser?.email).toBe("desktop@hermos.local");
      expect(state.currentUser?.name).toBe("Local Developer");
      expect(state.currentUser?.role).toBe("admin");
      expect(state.currentUser?.provider).toBe("local");
      expect(state.authLoading).toBe(false);
      expect(state.authChecked).toBe(true);
    });
  });

  describe("refreshAuth() robustness", () => {
    it("updates currentUser when /api/auth/me returns a valid user", async () => {
      const customUser: UserDTO = {
        id: "custom-user-1",
        email: "custom@hermos.local",
        name: "Custom Developer",
        role: "admin",
        provider: "local",
      };

      mockApiGet.mockResolvedValueOnce({ user: customUser });

      await useAppStore.getState().refreshAuth();

      const state = useAppStore.getState();
      expect(state.currentUser).toEqual(customUser);
      expect(state.authChecked).toBe(true);
      expect(state.authLoading).toBe(false);
    });

    it("falls back to DEFAULT_LOCAL_USER and is NEVER null when /api/auth/me returns null user", async () => {
      mockApiGet.mockResolvedValueOnce({ user: null });

      await useAppStore.getState().refreshAuth();

      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.id).toBe("desktop-user");
      expect(state.currentUser?.email).toBe("desktop@hermos.local");
      expect(state.authChecked).toBe(true);
    });

    it("falls back to DEFAULT_LOCAL_USER and is NEVER null when /api/auth/me throws network error", async () => {
      mockApiGet.mockRejectedValueOnce(new Error("Network Error / Offline"));

      await useAppStore.getState().refreshAuth();

      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.id).toBe("desktop-user");
      expect(state.currentUser?.email).toBe("desktop@hermos.local");
      expect(state.authChecked).toBe(true);
      expect(state.authLoading).toBe(false);
    });

    it("falls back to DEFAULT_LOCAL_USER when API returns undefined or empty object", async () => {
      mockApiGet.mockResolvedValueOnce({} as any);

      await useAppStore.getState().refreshAuth();

      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.id).toBe("desktop-user");
    });
  });

  describe("logout() safety", () => {
    it("clears workspace and conversation state but DOES NOT set currentUser to null", async () => {
      useAppStore.setState({
        conversations: [{ id: "conv-1", title: "C1", mode: "agent" } as any],
        messages: [{ id: "m-1", role: "user", content: "Hi", createdAt: "" }],
        openFiles: ["src/index.ts"],
        activeWorkspace: { id: "ws-1", name: "Project", isActive: true },
      });

      await useAppStore.getState().logout();

      const state = useAppStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.messages).toEqual([]);
      expect(state.openFiles).toEqual([]);
      expect(state.activeWorkspace).toBeNull();
      // Crucial requirement: currentUser is not cleared to null
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.id).toBe("desktop-user");
    });
  });

  describe("hydrate() lifecycle", () => {
    it("executes all startup refreshes in parallel and completes successfully", async () => {
      mockApiGet.mockResolvedValue({
        user: { id: "desktop-user", email: "desktop@hermos.local", name: "Local Developer", role: "admin", provider: "local" },
        providers: [],
        keys: [],
        conversations: [],
        servers: [],
        plugins: [],
        skills: [],
        presets: [],
        workspace: null,
      });
      mockApiPost.mockResolvedValue({ workspaces: [] });

      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();

      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.authChecked).toBe(true);
    });

    it("does not fail or crash hydrate() when all backend API routes reject (offline resilience)", async () => {
      mockApiGet.mockRejectedValue(new Error("Offline / Backend starting up"));
      mockApiPost.mockRejectedValue(new Error("Offline"));

      await expect(useAppStore.getState().hydrate()).resolves.toBeUndefined();

      const state = useAppStore.getState();
      expect(state.currentUser).not.toBeNull();
      expect(state.currentUser?.email).toBe("desktop@hermos.local");
    });
  });
});
