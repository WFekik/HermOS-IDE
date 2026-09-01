/**
 * Tests for src/lib/permissions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluatePermission,
  actionForTool,
  DEFAULT_PERMISSIONS,
  PERMISSIONS_PLUGIN_NAME,
  KNOWN_PERMISSION_ACTIONS,
  KNOWN_PERMISSION_MODES,
  type PermissionsConfig,
  type PermissionAction,
  type PermissionMode,
} from "./permissions";

// DB-touching tests: mock @/lib/db so we can exercise getPermissions /
// setPermissions in isolation without a real Prisma client. The mock
// exposes a `__reset()` helper invoked in beforeEach so test cases don't
// leak state into each other (vi.clearAllMocks only resets call history).

interface MockPluginRow {
  id: string;
  userId: string;
  name: string;
  type: string;
  config: string;
}

vi.mock("@/lib/db", () => {
  const store = new Map<string, MockPluginRow>();
  let nextId = 1;
  return {
    __resetMockDb: () => {
      store.clear();
      nextId = 1;
    },
    db: {
      plugin: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) => {
          for (const row of store.values()) {
            if (row.userId === where.userId && row.name === where.name) {
              return row;
            }
          }
          return null;
        }),
        upsert: vi.fn(async ({
          where,
          update,
          create,
        }: {
          where: { userId_name: { userId: string; name: string } };
          update: { config: string; type: string };
          create: { userId: string; name: string; type: string; config: string; source: string; enabled: boolean };
        }) => {
          const key = `${where.userId_name.userId}:${where.userId_name.name}`;
          for (const row of store.values()) {
            if (`${row.userId}:${row.name}` === key) {
              row.config = update.config;
              row.type = update.type;
              store.set(row.id, row);
              return row;
            }
          }
          const id = String(nextId++);
          const row: MockPluginRow = {
            id,
            userId: create.userId,
            name: create.name,
            type: create.type,
            config: create.config,
          };
          store.set(id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { config: string } }) => {
          const row = store.get(where.id);
          if (!row) throw new Error("not found");
          row.config = data.config;
          store.set(where.id, row);
          return row;
        }),
      },
    },
  };
});

// `permissions.ts` calls `audit(...)` from `@/app/api/_lib/helpers` inside
// setPermissions. The source wraps the call in try/catch, so a noop is fine.
vi.mock("@/app/api/_lib/helpers", () => ({
  audit: vi.fn(async () => {}),
}));

// Import the mocked module handle and the DB functions AFTER mocks are set up.
const { __resetMockDb } = (await import("@/lib/db")) as { __resetMockDb: () => void };
const { getPermissions, setPermissions, evaluateToolPermission, refreshPermissionsConfig } = await import("./permissions");

beforeEach(() => {
  vi.clearAllMocks();
  __resetMockDb();
});

describe("evaluatePermission — rule resolution", () => {
  it("returns the mode from the first matching rule", () => {
    const cfg: PermissionsConfig = {
      rules: [
        { action: "file.read", mode: "deny" },
        { action: "file.write", mode: "allow" },
      ],
      autoAllowReadonly: false,
    };
    expect(evaluatePermission(cfg, "file.read")).toBe("deny");
    expect(evaluatePermission(cfg, "file.write")).toBe("allow");
  });

  it("returns 'ask' for unknown actions when autoAllowReadonly is off", () => {
    const cfg: PermissionsConfig = { rules: [], autoAllowReadonly: false };
    expect(evaluatePermission(cfg, "file.read")).toBe("ask");
    expect(evaluatePermission(cfg, "command.run")).toBe("ask");
  });

  it("auto-allows readonly actions when autoAllowReadonly is on", () => {
    const cfg: PermissionsConfig = { rules: [], autoAllowReadonly: true };
    expect(evaluatePermission(cfg, "file.read")).toBe("allow");
    expect(evaluatePermission(cfg, "web.search")).toBe("allow");
    expect(evaluatePermission(cfg, "question.ask")).toBe("allow");
    // Non-readonly and web.fetch still default to 'ask'.
    expect(evaluatePermission(cfg, "web.fetch")).toBe("ask");
    expect(evaluatePermission(cfg, "file.write")).toBe("ask");
    expect(evaluatePermission(cfg, "command.run")).toBe("ask");
  });

  it("defaults subagent actions to allow when no rule is configured", () => {
    // Legacy behavior: subagent ops returned null from actionForTool → always
    // allowed. Preserve that for configs that predate these actions.
    const cfg: PermissionsConfig = { rules: [], autoAllowReadonly: false };
    expect(evaluatePermission(cfg, "subagent.spawn")).toBe("allow");
    expect(evaluatePermission(cfg, "subagent.get")).toBe("allow");
  });

  it("explicit rules override the subagent default", () => {
    const cfg: PermissionsConfig = {
      rules: [{ action: "subagent.spawn", mode: "deny" }],
      autoAllowReadonly: false,
    };
    expect(evaluatePermission(cfg, "subagent.spawn")).toBe("deny");
    // Sibling actions without explicit rules still default to allow.
    expect(evaluatePermission(cfg, "subagent.get")).toBe("allow");
  });

  it("explicit rule wins over autoAllowReadonly", () => {
    const cfg: PermissionsConfig = {
      rules: [{ action: "file.read", mode: "deny" }],
      autoAllowReadonly: true,
    };
    expect(evaluatePermission(cfg, "file.read")).toBe("deny");
  });

  it("respects first-match-wins ordering (not 'last rule wins')", () => {
    const cfg: PermissionsConfig = {
      rules: [
        { action: "file.write", mode: "ask" },
        { action: "file.write", mode: "allow" },
      ],
      autoAllowReadonly: false,
    };
    expect(evaluatePermission(cfg, "file.write")).toBe("ask");
  });
});

describe("actionForTool — tool name → permission action", () => {
  it("maps read-only file tools to file.read", () => {
    expect(actionForTool("read_file")).toBe("file.read");
    expect(actionForTool("list_directory")).toBe("file.read");
    expect(actionForTool("grep")).toBe("file.read");
    expect(actionForTool("glob")).toBe("file.read");
    expect(actionForTool("todo_read")).toBe("file.read");
    expect(actionForTool("todo_write")).toBe("file.write");
  });

  it("maps mutating file tools to file.write", () => {
    expect(actionForTool("write_file")).toBe("file.write");
    expect(actionForTool("edit_file")).toBe("file.write");
    expect(actionForTool("multi_edit")).toBe("file.write");
  });

  it("maps run_command to command.run", () => {
    expect(actionForTool("run_command")).toBe("command.run");
  });

  it("maps browser tools to their respective actions", () => {
    expect(actionForTool("browser_open")).toBe("browser.open");
    expect(actionForTool("browser_click")).toBe("browser.click");
    expect(actionForTool("browser_type")).toBe("browser.type");
  });

  it("maps web tools to their actions", () => {
    expect(actionForTool("http_fetch")).toBe("web.fetch");
    expect(actionForTool("web_search")).toBe("web.search");
  });

  it("maps mcp_call to mcp.call", () => {
    expect(actionForTool("mcp_call")).toBe("mcp.call");
  });

  it("maps subagent orchestration tools to their permission actions", () => {
    expect(actionForTool("spawn_subagent")).toBe("subagent.spawn");
    expect(actionForTool("get_subagent")).toBe("subagent.get");
  });

  it("returns explicit actions for office and utility tools", () => {
    expect(actionForTool("generate_ppt")).toBe("file.write");
    expect(actionForTool("generate_doc")).toBe("file.write");
    expect(actionForTool("generate_pdf")).toBe("file.write");
    expect(actionForTool("read_doc")).toBe("file.read");
  });

  it("returns null for unknown tool names", () => {
    expect(actionForTool("not_a_real_tool")).toBeNull();
    expect(actionForTool("")).toBeNull();
    expect(actionForTool("CREATE_FILE")).toBeNull(); // case-sensitive
  });
});

describe("normalize (round-trip via setPermissions + getPermissions)", () => {
  // The `normalize` function is module-private (not exported) — but it's
  // called by both setPermissions and getPermissions, so we exercise it
  // through the public surface. This is actually a stronger test because
  // it verifies the full persistence pipeline stays sanitized.

  it("strips actions that are not in KNOWN_PERMISSION_ACTIONS", async () => {
    await setPermissions("u1", {
      rules: [
        { action: "file.read", mode: "allow" },
        { action: "totally.fake.action" as unknown as PermissionAction, mode: "allow" },
        { action: "file.write", mode: "allow" },
      ],
      autoAllowReadonly: true,
    });
    const loaded = await getPermissions("u1");
    const actions = loaded.rules.map((r) => r.action);
    expect(actions).toContain("file.read");
    expect(actions).toContain("file.write");
    expect(actions).not.toContain("totally.fake.action" as PermissionAction);
  });

  it("strips entries with invalid modes", async () => {
    await setPermissions("u2", {
      rules: [
        { action: "file.read", mode: "kinda-sorta" as unknown as PermissionMode },
        { action: "file.write", mode: "allow" },
      ],
      autoAllowReadonly: false,
    });
    const loaded = await getPermissions("u2");
    expect(loaded.rules.length).toBe(1);
    expect(loaded.rules[0].action).toBe("file.write");
  });

  it("dedupes by action — first wins", async () => {
    await setPermissions("u3", {
      rules: [
        { action: "file.read", mode: "deny" },
        { action: "file.read", mode: "allow" },
      ],
      autoAllowReadonly: false,
    });
    const loaded = await getPermissions("u3");
    expect(loaded.rules.length).toBe(1);
    expect(loaded.rules[0].mode).toBe("deny");
  });

  it("skips null / non-object rule entries", async () => {
    // Cast: feeding garbage through the public API to verify the sanitizer
    // doesn't crash or persist malformed entries.
    await setPermissions("u4", {
      rules: [
        null as unknown as PermissionsConfig["rules"][number],
        undefined as unknown as PermissionsConfig["rules"][number],
        "string" as unknown as PermissionsConfig["rules"][number],
        { action: "file.read", mode: "allow" },
      ],
      autoAllowReadonly: true,
    });
    const loaded = await getPermissions("u4");
    expect(loaded.rules.length).toBe(1);
    expect(loaded.rules[0].action).toBe("file.read");
  });

  it("coerces autoAllowReadonly to boolean on the way out", async () => {
    await setPermissions("u5", {
      rules: [],
      autoAllowReadonly: 1 as unknown as boolean,
    });
    let loaded = await getPermissions("u5");
    expect(loaded.autoAllowReadonly).toBe(true);

    await setPermissions("u6", {
      rules: [],
      autoAllowReadonly: 0 as unknown as boolean,
    });
    loaded = await getPermissions("u6");
    expect(loaded.autoAllowReadonly).toBe(false);
  });

  it("preserves order of legitimate rules", async () => {
    const order: PermissionAction[] = [
      "command.run",
      "file.read",
      "web.fetch",
      "file.write",
    ];
    await setPermissions("u7", {
      rules: order.map((a) => ({ action: a, mode: "allow" as PermissionMode })),
      autoAllowReadonly: false,
    });
    const loaded = await getPermissions("u7");
    expect(loaded.rules.map((r) => r.action)).toEqual(order);
  });
});

describe("KNOWN_PERMISSION_ACTIONS / KNOWN_PERMISSION_MODES — exported clamps", () => {
  it("includes every action referenced by DEFAULT_PERMISSIONS", () => {
    for (const r of DEFAULT_PERMISSIONS.rules) {
      expect(KNOWN_PERMISSION_ACTIONS.has(r.action)).toBe(true);
    }
  });

  it("includes the three valid modes", () => {
    expect(KNOWN_PERMISSION_MODES.has("allow")).toBe(true);
    expect(KNOWN_PERMISSION_MODES.has("deny")).toBe(true);
    expect(KNOWN_PERMISSION_MODES.has("ask")).toBe(true);
    expect(KNOWN_PERMISSION_MODES.size).toBe(3);
  });

  it("does not include fabricated actions/modes", () => {
    expect(KNOWN_PERMISSION_ACTIONS.has("file.fake" as PermissionAction)).toBe(false);
    expect(KNOWN_PERMISSION_MODES.has("maybe" as PermissionMode)).toBe(false);
  });

  it("includes the subagent orchestration actions", () => {
    expect(KNOWN_PERMISSION_ACTIONS.has("subagent.spawn")).toBe(true);
    expect(KNOWN_PERMISSION_ACTIONS.has("subagent.get")).toBe(true);
  });
});

describe("DEFAULT_PERMISSIONS", () => {
  it("uses the v=2 permissive defaults documented in the source", () => {
    expect(DEFAULT_PERMISSIONS).toEqual({
      rules: [
        { action: "file.read", mode: "allow" },
        { action: "file.write", mode: "allow" },
        { action: "command.run", mode: "ask" },
        { action: "browser.open", mode: "ask" },
        { action: "browser.click", mode: "ask" },
        { action: "browser.type", mode: "ask" },
        { action: "web.fetch", mode: "ask" },
        { action: "web.search", mode: "allow" },
        { action: "mcp.call", mode: "ask" },
        { action: "subagent.spawn", mode: "allow" },
        { action: "question.ask", mode: "allow" },
      ],
      autoAllowReadonly: true,
    });
  });

  it("uses the reserved plugin name '__permissions__'", () => {
    expect(PERMISSIONS_PLUGIN_NAME).toBe("__permissions__");
  });
});

describe("getPermissions — DB-backed (mocked)", () => {
  it("returns DEFAULT_PERMISSIONS when the user has no saved config", async () => {
    const cfg = await getPermissions("user-no-saved-config");
    expect(cfg.rules.length).toBe(DEFAULT_PERMISSIONS.rules.length);
    expect(cfg.autoAllowReadonly).toBe(true);
  });

  it("returns DEFAULT_PERMISSIONS AND migrates when saved config has v != 2", async () => {
    // Pre-seed a v=1 row by calling setPermissions with a synthetic marker (we can't bypass
    // normalize, so we just confirm that ANY config without v=2 in the persisted JSON triggers the
    // migration).
    const { db } = await import("@/lib/db");
    await db.plugin.upsert({
      where: { userId_name: { userId: "user-old-config", name: PERMISSIONS_PLUGIN_NAME } },
      update: { config: JSON.stringify({ v: 1, rules: [], autoAllowReadonly: false }), type: "plugin" },
      create: {
        userId: "user-old-config",
        name: PERMISSIONS_PLUGIN_NAME,
        type: "plugin",
        source: "system",
        enabled: true,
        config: JSON.stringify({ v: 1, rules: [], autoAllowReadonly: false }),
      },
    });
    const cfg = await getPermissions("user-old-config");
    expect(cfg.rules.length).toBe(DEFAULT_PERMISSIONS.rules.length);
    // Migration persisted v=2 — second call still returns defaults.
    const cfg2 = await getPermissions("user-old-config");
    expect(cfg2.rules.map((r) => r.mode)).toEqual(
      DEFAULT_PERMISSIONS.rules.map((r) => r.mode),
    );
  });

  it("returns sanitized config when v=2", async () => {
    const { db } = await import("@/lib/db");
    await db.plugin.upsert({
      where: { userId_name: { userId: "user-good-config", name: PERMISSIONS_PLUGIN_NAME } },
      update: {
        config: JSON.stringify({
          v: 2,
          rules: [
            { action: "browser.click", mode: "deny" },
            { action: "totally.fake" as PermissionAction, mode: "allow" },
            { action: "file.write", mode: "allow" },
          ],
          autoAllowReadonly: true,
        }),
        type: "plugin",
      },
      create: {
        userId: "user-good-config",
        name: PERMISSIONS_PLUGIN_NAME,
        type: "plugin",
        source: "system",
        enabled: true,
        config: JSON.stringify({
          v: 2,
          rules: [
            { action: "browser.click", mode: "deny" },
            { action: "totally.fake" as PermissionAction, mode: "allow" },
            { action: "file.write", mode: "allow" },
          ],
          autoAllowReadonly: true,
        }),
      },
    });
    const cfg = await getPermissions("user-good-config");
    const actions = cfg.rules.map((r) => r.action);
    expect(actions).toContain("browser.click");
    expect(actions).toContain("file.write");
    expect(actions).not.toContain("totally.fake" as PermissionAction);
    expect(cfg.rules.find((r) => r.action === "browser.click")?.mode).toBe("deny");
  });

  it("falls back to DEFAULT_PERMISSIONS on JSON parse error", async () => {
    const { db } = await import("@/lib/db");
    await db.plugin.upsert({
      where: { userId_name: { userId: "user-corrupt-config", name: PERMISSIONS_PLUGIN_NAME } },
      update: { config: "this is not json{", type: "plugin" },
      create: {
        userId: "user-corrupt-config",
        name: PERMISSIONS_PLUGIN_NAME,
        type: "plugin",
        source: "system",
        enabled: true,
        config: "this is not json{",
      },
    });
    const cfg = await getPermissions("user-corrupt-config");
    expect(cfg.rules.length).toBe(DEFAULT_PERMISSIONS.rules.length);
  });
});

describe("setPermissions — DB-backed (mocked)", () => {
  it("persists with v=2 marker", async () => {
    await setPermissions("user-set-perms", {
      rules: [{ action: "file.read", mode: "deny" }],
      autoAllowReadonly: false,
    });
    const { db } = await import("@/lib/db");
    const row = await db.plugin.findFirst({
      where: { userId: "user-set-perms", name: PERMISSIONS_PLUGIN_NAME },
    });
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row!.config);
    expect(parsed.v).toBe(2);
    expect(parsed.rules[0]).toEqual({ action: "file.read", mode: "deny" });
  });

  it("normalizes before persisting (rejects fake actions)", async () => {
    const cfg = await setPermissions("user-set-bad-perms", {
      rules: [
        { action: "file.read", mode: "allow" },
        { action: "fake.action" as PermissionAction, mode: "allow" },
      ],
      autoAllowReadonly: true,
    });
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0].action).toBe("file.read");

    // Verify the persisted JSON has been sanitized too.
    const { db } = await import("@/lib/db");
    const row = await db.plugin.findFirst({
      where: { userId: "user-set-bad-perms", name: PERMISSIONS_PLUGIN_NAME },
    });
    const parsed = JSON.parse(row!.config);
    expect(parsed.rules.length).toBe(1);
  });

  it("is idempotent — re-setting the same config yields the same normalized form", async () => {
    const input: PermissionsConfig = {
      rules: [{ action: "file.write", mode: "ask" }],
      autoAllowReadonly: false,
    };
    const a = await setPermissions("user-set-twice", input);
    const b = await setPermissions("user-set-twice", input);
    expect(a).toEqual(b);
  });
});

describe("evaluateToolPermission — convenience wrapper", () => {
  it("returns 'allow' for tools with no associated action", async () => {
    expect(await evaluateToolPermission("u1", "web_search")).toBe("allow");
    expect(await evaluateToolPermission("u1", "generate_ppt")).toBe("allow");
    expect(await evaluateToolPermission("u1", "spawn_subagent")).toBe("allow");
    expect(await evaluateToolPermission("u1", "get_subagent")).toBe("allow");
  });

  it("returns the configured mode for mapped tools", async () => {
    // DEFAULT_PERMISSIONS has file.read=allow, command.run=ask, mcp.call=ask.
    expect(await evaluateToolPermission("u1", "read_file")).toBe("allow");
    expect(await evaluateToolPermission("u1", "run_command")).toBe("ask");
    expect(await evaluateToolPermission("u1", "mcp_call")).toBe("ask");
  });

  it("FORCES deny in architect mode for any mutating action", async () => {
    // Even if user has allowed command.run, architect mode hard-denies it.
    await setPermissions("arch-user", {
      rules: [
        { action: "command.run", mode: "allow" },
        { action: "file.write", mode: "allow" },
        { action: "browser.open", mode: "allow" },
      ],
      autoAllowReadonly: true,
    });
    expect(await evaluateToolPermission("arch-user", "run_command", "architect")).toBe("deny");
    expect(await evaluateToolPermission("arch-user", "write_file", "architect")).toBe("deny");
    expect(await evaluateToolPermission("arch-user", "browser_open", "architect")).toBe("deny");
    expect(await evaluateToolPermission("arch-user", "mcp_call", "architect")).toBe("deny");
    // Read-only actions are still allowed in architect mode.
    expect(await evaluateToolPermission("arch-user", "read_file", "architect")).toBe("allow");
    expect(await evaluateToolPermission("arch-user", "web_search", "architect")).toBe("allow");
    // Subagent orchestration is NOT hard-denied: architect may spawn research
    // subagents, whose allowedTools the executor clips to read-only tools.
    expect(await evaluateToolPermission("arch-user", "spawn_subagent", "architect")).toBe("allow");
    expect(await evaluateToolPermission("arch-user", "get_subagent", "architect")).toBe("allow");
  });

  it("does NOT force-deny in agent mode (uses user config)", async () => {
    await setPermissions("agent-user", {
      rules: [{ action: "command.run", mode: "allow" }],
      autoAllowReadonly: true,
    });
    expect(await evaluateToolPermission("agent-user", "run_command", "agent")).toBe("allow");
  });

  it("does NOT force-deny in chat mode (uses user config)", async () => {
    await setPermissions("chat-user", {
      rules: [{ action: "command.run", mode: "ask" }],
      autoAllowReadonly: true,
    });
    expect(await evaluateToolPermission("chat-user", "run_command", "chat")).toBe("ask");
  });

  it("keeps subagent tools allowed for custom configs without subagent rules", async () => {
    // Backward compatibility: a v2 config saved before subagent actions
    // existed must not suddenly gate subagent tools.
    await setPermissions("custom-subagent-user", {
      rules: [{ action: "file.write", mode: "allow" }],
      autoAllowReadonly: false,
    });
    expect(await evaluateToolPermission("custom-subagent-user", "spawn_subagent")).toBe("allow");
    expect(await evaluateToolPermission("custom-subagent-user", "get_subagent")).toBe("allow");
  });

  it("honors explicit subagent rules set via config", async () => {
    await setPermissions("restrict-subagent-user", {
      rules: [
        { action: "subagent.spawn", mode: "deny" },
        { action: "subagent.get", mode: "ask" },
      ],
      autoAllowReadonly: false,
    });
    expect(await evaluateToolPermission("restrict-subagent-user", "spawn_subagent")).toBe("deny");
    expect(await evaluateToolPermission("restrict-subagent-user", "get_subagent")).toBe("ask");
    // No explicit rule → legacy default "allow".
    expect(await evaluateToolPermission("restrict-subagent-user", "spawn_subagent")).toBe("deny");
  });
});

describe("refreshPermissionsConfig — batch snapshot refresh", () => {
  // The agent loop pre-screens a batch of tool calls against a single
  // config snapshot. An "always_allow" decision persists a new allow rule
  // (POST /api/permissions/pending), so sibling calls in the same batch
  // must be screened against a fresh snapshot — the stale one would
  // otherwise re-prompt for the exact action the user just auto-allowed.

  it("returns the passed snapshot unchanged for one-shot decisions", async () => {
    const cfg: PermissionsConfig = {
      rules: [{ action: "mcp.call", mode: "ask" }],
      autoAllowReadonly: false,
    };
    expect(await refreshPermissionsConfig("u1", "allow", cfg)).toBe(cfg);
    expect(await refreshPermissionsConfig("u1", "deny", cfg)).toBe(cfg);
  });

  it("re-reads the persisted config after always_allow so the new rule takes effect", async () => {
    await setPermissions("u-batch", {
      rules: [{ action: "mcp.call", mode: "ask" }],
      autoAllowReadonly: false,
    });
    const stale = await getPermissions("u-batch");
    expect(evaluatePermission(stale, "mcp.call")).toBe("ask");

    // Simulate what POST /api/permissions/pending does for "always_allow":
    // persist an "allow" rule for the action (replacing the old one).
    const config = await getPermissions("u-batch");
    await setPermissions("u-batch", {
      ...config,
      rules: [
        ...config.rules.filter((r) => r.action !== "mcp.call"),
        { action: "mcp.call", mode: "allow" },
      ],
    });

    const fresh = await refreshPermissionsConfig("u-batch", "always_allow", stale);
    expect(fresh).not.toBe(stale);
    expect(evaluatePermission(fresh, "mcp.call")).toBe("allow");
  });

  it("degrades to DEFAULT_PERMISSIONS if the re-read throws", async () => {
    const cfg: PermissionsConfig = {
      rules: [{ action: "mcp.call", mode: "ask" }],
      autoAllowReadonly: false,
    };
    const { db } = await import("@/lib/db");
    (db.plugin.findFirst as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("db down");
      },
    );
    const result = await refreshPermissionsConfig("u-fail", "always_allow", cfg);
    expect(result.rules.length).toBe(DEFAULT_PERMISSIONS.rules.length);
    // The call still succeeds — the executor's best-effort refresh cannot
    // throw and kill the agent loop mid-batch.
    expect(result.autoAllowReadonly).toBe(true);
  });
});