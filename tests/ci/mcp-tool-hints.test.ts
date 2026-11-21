import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLS } from '../../src/lib/ai/tools';

describe('MCP & OpenAI Directory Tool Declarations Integrity (M8ven Compliance)', () => {
  it('declares exactly 40 built-in tools', () => {
    expect(BUILTIN_TOOLS.length).toBe(40);
  });

  it('guarantees all 40 tools have explicit boolean hints required by OpenAI and M8ven', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(
        typeof tool.readOnlyHint,
        `Tool "${tool.name}" must declare a boolean readOnlyHint`,
      ).toBe('boolean');
      expect(
        typeof tool.destructiveHint,
        `Tool "${tool.name}" must declare a boolean destructiveHint`,
      ).toBe('boolean');
      expect(
        typeof tool.idempotentHint,
        `Tool "${tool.name}" must declare a boolean idempotentHint`,
      ).toBe('boolean');
      expect(
        typeof tool.openWorldHint,
        `Tool "${tool.name}" must declare a boolean openWorldHint`,
      ).toBe('boolean');
    }
  });

  it('marks pure read-only inspection tools with readOnlyHint: true', () => {
    const readOnlyTools = ['read_file', 'list_directory', 'grep', 'glob', 'todo_read', 'read_doc'];
    for (const name of readOnlyTools) {
      const tool = BUILTIN_TOOLS.find((t) => t.name === name);
      expect(tool, `Tool ${name} should exist`).toBeDefined();
      expect(tool?.readOnlyHint).toBe(true);
      expect(tool?.destructiveHint).toBe(false);
    }
  });

  it('marks filesystem mutating and shell execution tools as destructive when appropriate', () => {
    const writeTool = BUILTIN_TOOLS.find((t) => t.name === 'write_file');
    expect(writeTool?.destructiveHint).toBe(true);

    const cmdTool = BUILTIN_TOOLS.find((t) => t.name === 'run_command');
    expect(cmdTool?.destructiveHint).toBe(true);
    expect(cmdTool?.openWorldHint).toBe(true);
  });
});
