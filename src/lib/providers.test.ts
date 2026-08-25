import { describe, it, expect } from "vitest";
import { getProvider } from "./ai/providers";

describe("Dynamic Custom Provider Resolution", () => {
  it("resolves built-in provider openrouter", () => {
    const p = getProvider("openrouter");
    expect(p).toBeDefined();
    expect(p?.name).toBe("OpenRouter");
  });

  it("resolves dynamic custom provider custom:Ollama", () => {
    const p = getProvider("custom:Ollama");
    expect(p).toBeDefined();
    expect(p?.name).toBe("Ollama");
    expect(p?.supportsNativeFunctionCalling).toBe(true);
  });

  it("resolves dynamic custom provider custom:vLLM-GPU", () => {
    const p = getProvider("custom:vLLM-GPU");
    expect(p).toBeDefined();
    expect(p?.name).toBe("vLLM-GPU");
    expect(p?.requiresKey).toBe(true);
  });
});
