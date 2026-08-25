/**
 * Deterministic brand resolution for provider/model logos (model family > provider ID > keyword match > neutral).
 * Pure module safe for client and server usage.
 */

export type Brand =
  | "meta"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "zhipu"
  | "kimi"
  | "grok"
  | "groq"
  | "together"
  | "perplexity"
  | "siliconflow"
  | "yi"
  | "mistral"
  | "microsoft"
  | "minimax"
  | "cohere"
  | "qwen"
  | "stepfun"
  | "writer"
  | "nvidia"
  | "doubao"
  | "ernie"
  | "hunyuan"
  | "baichuan"
  | "sarvam"
  | "upstage"
  | "fireworks"
  | "deepinfra"
  | "sambanova"
  | "cerebras"
  | "replicate"
  | "modal"
  | "puter"
  | "huggingface"
  | "opencode"
  | "allam"
  | "orpheus"
  | "compound"
  | "neutral";

/** Deterministic provider-id → brand mapping for every known id/alias. */
export const BRAND_BY_PROVIDER_ID: Readonly<Record<string, Brand>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  groq: "groq",
  nvidia: "nvidia",
  mistral: "mistral",
  together: "together",
  deepseek: "deepseek",
  zhipu: "zhipu",
  glm: "zhipu",
  kimi: "kimi",
  moonshot: "kimi",
  qwen: "qwen",
  alibaba: "qwen",
  minimax: "minimax",
  xai: "grok",
  grok: "grok",
  microsoft: "microsoft",
  doubao: "doubao",
  volcengine: "doubao",
  ark: "doubao",
  baidu: "ernie",
  ernie: "ernie",
  wenxin: "ernie",
  tencent: "hunyuan",
  hunyuan: "hunyuan",
  baichuan: "baichuan",
  sarvam: "sarvam",
  upstage: "upstage",
  writer: "writer",
  cohere: "cohere",
  stepfun: "stepfun",
  perplexity: "perplexity",
  siliconflow: "siliconflow",
  "silicon-flow": "siliconflow",
  silicon: "siliconflow",
  "01-ai": "yi",
  yi: "yi",
  fireworks: "fireworks",
  deepinfra: "deepinfra",
  sambanova: "sambanova",
  cerebras: "cerebras",
  replicate: "replicate",
  modal: "modal",
  puter: "puter",
  huggingface: "huggingface",
  hf: "huggingface",
  zen: "opencode",
  opencode: "opencode",
  allam: "allam",
  orpheus: "orpheus",
  compound: "compound",
  meta: "meta",
};

/** Model-family → brand, ordered so the most specific match wins. */
export const MODEL_FAMILY_RULES: ReadonlyArray<{ brand: Brand; tokens: readonly string[] }> = [
  { brand: "meta", tokens: ["llama", "meta", "prompt-guard", "prompt_guard"] },
  { brand: "openai", tokens: ["gpt", "chatgpt", "openai"] },
  { brand: "anthropic", tokens: ["claude", "anthropic"] },
  { brand: "google", tokens: ["gemini", "gemma"] },
  { brand: "deepseek", tokens: ["deepseek"] },
  { brand: "mistral", tokens: ["mistral", "codestral", "ministral", "minitron"] },
  { brand: "zhipu", tokens: ["glm", "zhipu", "chatglm"] },
  { brand: "kimi", tokens: ["kimi", "moonshot"] },
  { brand: "qwen", tokens: ["qwen", "alibaba"] },
  { brand: "minimax", tokens: ["minimax"] },
  { brand: "grok", tokens: ["grok"] },
  { brand: "nvidia", tokens: ["nemotron", "nemoretriever", "neva"] },
  { brand: "microsoft", tokens: ["phi", "kosmos"] },
  { brand: "allam", tokens: ["allam"] },
  { brand: "orpheus", tokens: ["orpheus"] },
  { brand: "compound", tokens: ["compound"] },
  { brand: "yi", tokens: ["yi", "01-ai", "01.ai"] },
  { brand: "doubao", tokens: ["doubao", "volcengine"] },
  { brand: "ernie", tokens: ["ernie", "wenxin"] },
  { brand: "hunyuan", tokens: ["hunyuan"] },
  { brand: "baichuan", tokens: ["baichuan"] },
  { brand: "sarvam", tokens: ["sarvam"] },
  { brand: "upstage", tokens: ["solar", "upstage"] },
  { brand: "writer", tokens: ["palmyra", "writer"] },
  { brand: "cohere", tokens: ["cohere", "command"] },
  { brand: "stepfun", tokens: ["stepfun"] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-segment match: the token must start at a boundary (^ or non-alnum),
// and be followed by the end, a non-letter, or a digit in the next position.
// This keeps `oss`/`hf` from matching inside longer words (`cross-encoder`,
// `spark`) while still recognizing compact ad-free ids like `llama3`, `gpt4o`.
const matchesAny = (text: string, tokens: readonly string[]) =>
  tokens.some((t) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(t)}(?:$|[^a-z])`).test(text));

/**
 * Resolve the brand for a provider/model pair. See module docs for the
 * deterministic-first resolution order.
 */
export function resolveBrand(providerId?: string | null, modelId?: string | null): Brand {
  const p = (providerId || "").toLowerCase().trim();
  const m = (modelId || "").toLowerCase().trim();

  if (m) {
    for (const rule of MODEL_FAMILY_RULES) {
      if (matchesAny(m, rule.tokens)) return rule.brand;
    }
  }

  if (p) {
    const exact = BRAND_BY_PROVIDER_ID[p];
    if (exact) return exact;
    // Unknown/custom provider id: only trust distinctive (≥3 char) keywords,
    // so `spark`, `dark-ai`, `cross-encoder` never get mislabeled.
    for (const rule of MODEL_FAMILY_RULES) {
      const distinctive = rule.tokens.filter((t) => t.length >= 3);
      if (distinctive.length && matchesAny(p, distinctive)) return rule.brand;
    }
  }

  return "neutral";
}
