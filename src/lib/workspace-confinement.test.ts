import { describe, it, expect } from "vitest";
import path from "path";
import { WORKSPACES_ROOT } from "@/lib/paths";

describe("Workspace from-folder tenant confinement in cloud mode", () => {
  function checkCloudPathConfinement(userId: string, folderPath: string): boolean {
    const userWorkspacesRoot = path.resolve(WORKSPACES_ROOT, userId);
    const rel = path.relative(userWorkspacesRoot, folderPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return false; // Forbidden: escapes user workspace root
    }
    return true; // Allowed: inside user's directory
  }

  it("allows paths strictly inside the user's workspace directory", () => {
    const userId = "cuid_user_123";
    const validProject = path.join(WORKSPACES_ROOT, userId, "my-app");
    const validNested = path.join(WORKSPACES_ROOT, userId, "frontend", "nested");

    expect(checkCloudPathConfinement(userId, validProject)).toBe(true);
    expect(checkCloudPathConfinement(userId, validNested)).toBe(true);
  });

  it("rejects cross-tenant workspace folder hijacking", () => {
    const tenantA = "cuid_tenant_alice";
    const tenantB = "cuid_tenant_bob";

    // Alice tries to open Bob's project
    const bobsProject = path.join(WORKSPACES_ROOT, tenantB, "secret-finance-app");
    expect(checkCloudPathConfinement(tenantA, bobsProject)).toBe(false);

    // Bob tries to open Alice's project
    const alicesProject = path.join(WORKSPACES_ROOT, tenantA, "my-app");
    expect(checkCloudPathConfinement(tenantB, alicesProject)).toBe(false);
  });

  it("rejects host filesystem root escapes", () => {
    const userId = "cuid_user_123";
    expect(checkCloudPathConfinement(userId, "/etc")).toBe(false);
    expect(checkCloudPathConfinement(userId, "/root")).toBe(false);
    expect(checkCloudPathConfinement(userId, "C:\\Windows")).toBe(false);
    expect(checkCloudPathConfinement(userId, path.resolve(WORKSPACES_ROOT))).toBe(false);
  });
});
