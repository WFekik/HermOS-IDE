import type { SupportedLanguage } from "@/lib/i18n";

/**
 * Heuristic prompt-language detection (dependency-free).
 *
 * The agent answers in the language the user writes in — never English by
 * default. Script detection decides non-Latin input (Arabic, Cyrillic, CJK);
 * Latin-script languages use stop-word scoring (threshold 2, ties fall
 * back). Code fences, inline code, and URLs are stripped first since code
 * is overwhelmingly English. Ambiguous input returns the fallback.
 */

export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  zh: "Chinese",
  ja: "Japanese",
  ar: "Arabic",
  ru: "Russian",
  pt: "Portuguese",
};

export function languageDisplayName(code: SupportedLanguage): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? "English";
}

/** High-signal stop words per Latin language (chosen to be rare in English prose). */
const LATIN_MARKERS: Record<string, Array<string>> = {
  fr: [
    "les", "des", "une", "est", "sont", "pour", "avec", "dans", "comment",
    "pourquoi", "parce", "merci", "voici", "quelle", "quelles", "votre",
    "nous", "vous", "faire", "peut", "pas", "plus", "comme", "ce", "en",
  ],
  es: [
    "los", "las", "una", "está", "son", "para", "porque", "cómo", "cuál",
    "gracias", "dónde", "tiene", "hacer", "puede", "este", "esta", "entre",
  ],
  de: [
    "der", "die", "das", "und", "ist", "nicht", "mit", "für", "auf", "eine",
    "einem", "einen", "auch", "warum", "welche", "danke", "bitte", "wird",
    "werden", "haben", "kann", "nicht",
  ],
  pt: [
    "para", "porque", "obrigado", "onde", "quando", "este", "esta", "isso",
    "fazer", "pode", "muito", "também", "você", "entre", "como",
  ],
};

function stripCodeAndUrls(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[\w./-]+/g, " ");
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function detectPromptLanguage(
  text: string,
  fallback: SupportedLanguage = "en",
): SupportedLanguage {
  const clean = stripCodeAndUrls(text ?? "");
  if (!clean.trim()) return fallback;

  const arabic = countMatches(clean, /[؀-ۿ]/g);
  const cyrillic = countMatches(clean, /[Ѐ-ӿ]/g);
  const han = countMatches(clean, /[一-鿿]/g);
  const kana = countMatches(clean, /[぀-ヿ]/g);
  const latin = countMatches(clean, /[A-Za-z]/g);
  const scriptTotal = arabic + cyrillic + han + kana + latin;
  if (scriptTotal === 0) return fallback;

  // Kana is uniquely Japanese (kanji overlap with Chinese is resolved by it).
  if (kana >= 2) return "ja";
  // Any other non-Latin script with at least a 30% share decides.
  const share = (n: number) => n / scriptTotal;
  if (share(arabic) >= 0.3) return "ar";
  if (share(cyrillic) >= 0.3) return "ru";
  if (share(han) >= 0.3) return "zh";
  // Single kana char + han majority (e.g. short mixed input) → Japanese.
  if (kana >= 1 && han > latin) return "ja";

  // Latin-script: distinctive stop-word scoring, threshold 2, ties fall back.
  const words = new Set(clean.toLowerCase().split(/[^a-zà-ÿâêîôûäöüßçñ]+/));
  let best: SupportedLanguage | null = null;
  let bestScore = 0;
  let tied = false;
  for (const [lang, markers] of Object.entries(LATIN_MARKERS)) {
    let score = 0;
    for (const w of markers) {
      if (words.has(w)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = lang as SupportedLanguage;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  if (best && bestScore >= 2 && !tied) return best;
  return fallback;
}
