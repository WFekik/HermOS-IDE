"use client";

import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import { Cpu } from "lucide-react";
import type { Brand } from "@/lib/brands";
import { resolveBrand } from "@/lib/brands";

interface ProviderLogoProps {
  providerId?: string;
  modelId?: string;
  brand?: Brand;
  className?: string;
  size?: number;
}

/** DeepSeek — Official DeepSeek whale emblem */
export function DeepSeekLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#4D6BFE" className={cn("shrink-0", className)}>
      <path d="M23.748 4.651c-.254-.124-.364.113-.512.233c-.051.04-.094.09-.137.137c-.372.397-.806.657-1.373.626c-.829-.046-1.537.214-2.163.848c-.133-.782-.575-1.248-1.247-1.548c-.352-.155-.708-.311-.955-.65c-.172-.24-.219-.509-.305-.774c-.055-.16-.11-.323-.293-.35c-.2-.031-.278.136-.356.276c-.313.572-.434 1.202-.422 1.84c.027 1.436.633 2.58 1.838 3.393c.137.094.172.187.129.323c-.082.28-.18.553-.266.833c-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836c.27-.098.094-.433-.778-.428c-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136a9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653c1.857 1.533 3.997 2.284 6.438 2.14c1.482-.085 3.132-.284 4.994-1.86c.47.234.962.328 1.78.398c.629.058 1.235-.031 1.705-.129c.735-.155.684-.836.418-.961c-2.155-1.004-1.682-.595-2.112-.926c1.095-1.295 2.768-3.598 3.284-6.733c.05-.346.115-.834.108-1.114c-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517c.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16c-.39.024-.32.472-.234.763c.09.288.207.487.371.74c.114.167.192.416-.113.603c-.673.416-1.842-.14-1.897-.168c-1.361-.801-2.5-1.86-3.301-3.306c-.775-1.393-1.225-2.888-1.299-4.482c-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774c.868.86 1.525 1.887 2.202 2.89c.72 1.066 1.494 2.082 2.48 2.915c.348.291.626.513.892.677c-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287a.3.3 0 0 1 .113.074a.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727c-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078a.253.253 0 0 1-.114-.358a1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016c.352.144.618.408 1.001.782c.392.451.462.576.685.915c.176.264.336.536.446.848c.066.194-.02.353-.25.45" />
    </svg>
  );
}

/** OpenAI — Monochrome: dark slate in Light Mode, crisp white in Dark Mode */
export function OpenAILogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={cn("shrink-0 text-slate-900 dark:text-slate-100", className)}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0813 4.7792-2.7582a.7954.7954 0 0 0 .3927-.6813v-6.7369l2.0228 1.1683a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4982 4.4946zm-9.6607-4.1254a4.4707 4.4707 0 0 1-.5359-3.0137l.142.0853 4.7839 2.7582a.7954.7954 0 0 0 .7854 0l5.8335-3.3692v2.3366a.071.071 0 0 1-.0284.0569l-4.836 2.7914a4.5088 4.5088 0 0 1-6.1445-1.6455zm-1.2285-10.452a4.4755 4.4755 0 0 1 2.3452-1.9774v5.6774a.7954.7954 0 0 0 .3927.6813l5.8335 3.3692-2.0228 1.1683a.071.071 0 0 1-.0663.0047l-4.836-2.7914a4.504 4.504 0 0 1-1.6463-6.1321zm16.6575 3.8407l-5.8335-3.3692 2.0228-1.1683a.071.071 0 0 1 .0663-.0047l4.836 2.7914a4.5088 4.5088 0 0 1 1.6416 6.1368 4.4707 4.4707 0 0 1-2.3405 1.9774v-5.6822a.7859.7859 0 0 0-.3927-.6812zm2.2577-4.5772l-.142-.0853-4.7792-2.7582a.7954.7954 0 0 0-.7854 0l-5.8335 3.3692V5.7337a.071.071 0 0 1 .0284-.0569l4.836-2.7914a4.5088 4.5088 0 0 1 6.6757 4.6192zm-12.6393-3.695a4.4755 4.4755 0 0 1 2.8811 1.0407l-.1419.0813-4.7792 2.7582a.7954.7954 0 0 0-.3927.6813v6.7369l-2.0228-1.1683a.071.071 0 0 1-.038-.052V6.3686a4.504 4.504 0 0 1 4.4935-4.4946z" />
    </svg>
  );
}

/** Anthropic — Official Claude terracotta brand color */
export function AnthropicLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#CC785C" className={cn("shrink-0", className)}>
      <path d="M13.827 3.518h-3.654L4.31 20.482h3.654l1.196-3.486h5.68l1.196 3.486h3.654L13.827 3.518zm-3.606 10.706l2.128-6.205 2.128 6.205h-4.256z" />
    </svg>
  );
}

/** Google / Gemini */
export function GoogleLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0", className)}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 6.93 9.14 4.75 12 4.75z" />
    </svg>
  );
}

/** Zhipu AI / GLM / ChatGLM — Blue hexagon grid emblem */
export function ZhipuLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M12 2L21 7.2v9.6L12 22L3 16.8V7.2L12 2z" stroke="#3B82F6" strokeWidth="2" strokeLinejoin="round" fill="#3B82F6" fillOpacity="0.15" />
      <path d="M12 6.5L16.5 9v6L12 17.5L7.5 15V9L12 6.5z" fill="#2563EB" />
      <circle cx="12" cy="12" r="2" fill="#FFFFFF" />
    </svg>
  );
}

/** Kimi / Moonshot AI — Monochrome light/dark circle emblem with 'k' */
export function KimiLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" className="text-slate-900 dark:text-slate-100" />
      <path d="M8.5 7v10M8.5 12l5-5M8.5 12l5.5 5.5" stroke="currentColor" className="text-white dark:text-slate-950" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** X.AI / Grok — Monochrome light/dark adaptable emblem */
export function GrokLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={cn("shrink-0 text-slate-900 dark:text-slate-100", className)}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Groq — Groq red/orange emblem */
export function GroqLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="#F55036" />
      <circle cx="11.5" cy="12" r="3.5" stroke="#FFFFFF" strokeWidth="2" />
      <path d="M14 14.5l2.5 2.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Together AI */
export function TogetherLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <rect x="3" y="3" width="12" height="12" rx="2.5" fill="#6366F1" fillOpacity="0.9" />
      <rect x="9" y="9" width="12" height="12" rx="2.5" fill="#818CF8" />
    </svg>
  );
}

/** Perplexity AI / Sonar */
export function PerplexityLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07L19.07 4.93" stroke="#22B8CD" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** SiliconFlow / SiliconCloud */
export function SiliconFlowLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 4.2l5.2 3.2v5.2L12 17.8l-5.2-3.2V9.4L12 6.2z" fill="#2563EB" />
      <circle cx="12" cy="12" r="2.8" fill="#60A5FA" />
    </svg>
  );
}

/** Yi / 01.AI */
export function YiLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <rect x="4" y="4" width="7" height="16" rx="1.5" fill="#7C3AED" />
      <rect x="13" y="4" width="7" height="16" rx="1.5" fill="#A78BFA" />
    </svg>
  );
}

/** Doubao / Volcengine / ByteDance */
export function DoubaoLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M12 3C7.03 3 3 6.58 3 11c0 2.5 1.28 4.74 3.3 6.27L5 21l4.47-1.49C10.3 19.83 11.14 20 12 20c4.97 0 9-3.58 9-8s-4.03-9-9-9z" fill="#3370FF" />
      <circle cx="12" cy="11" r="2.5" fill="#FFFFFF" />
    </svg>
  );
}

/** Baidu / Ernie Bot / Wenxin */
export function ErnieLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#2932E1" className={cn("shrink-0", className)}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm-4.5 7a2 2 0 110 4 2 2 0 010-4zm9 0a2 2 0 110 4 2 2 0 010-4zm-4.5 4a2.5 2.5 0 110 5 2.5 2.5 0 010-5z" />
    </svg>
  );
}

/** Tencent / Hunyuan */
export function HunyuanLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 14c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" fill="#0052D9" />
    </svg>
  );
}

/** Baichuan AI */
export function BaichuanLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <path d="M3 12c4.5-4.5 9-4.5 13.5 0s9 4.5 13.5 0" stroke="#FF5722" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Sarvam AI */
export function SarvamLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#FF9933" className={cn("shrink-0", className)}>
      <path d="M12 2l2.8 6.2L21 11l-6.2 2.8L12 20l-2.8-6.2L3 11l6.2-2.8z" />
    </svg>
  );
}

/** Fireworks AI */
export function FireworksLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#FF4500" className={cn("shrink-0", className)}>
      <path d="M12 2c0 0-4 4-4 8 0 2.21 1.79 4 4 4s4-1.79 4-4c0-4-4-8-4-8zm-6 9c0 0-3 3-3 6 0 1.66 1.34 3 3 3s3-1.34 3-3c0-3-3-6-3-6zm12 0c0 0-3 3-3 6 0 1.66 1.34 3 3 3s3-1.34 3-3c0-3-3-6-3-6z" />
    </svg>
  );
}

/** DeepInfra */
export function DeepInfraLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#0284C7" className={cn("shrink-0", className)}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  );
}

/** SambaNova */
export function SambaNovaLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#FF6B00" className={cn("shrink-0", className)}>
      <path d="M12 2L2 12l10 10 10-10L12 2zm0 4.5l6.5 6.5-6.5 6.5L5.5 13 12 6.5z" />
    </svg>
  );
}

/** Cerebras */
export function CerebrasLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <rect x="4" y="4" width="16" height="16" rx="2" stroke="#06B6D4" strokeWidth="2" />
      <rect x="8" y="8" width="8" height="8" fill="#06B6D4" />
    </svg>
  );
}

/** Replicate — Monochrome light/dark adaptable emblem */
export function ReplicateLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={cn("shrink-0 text-slate-900 dark:text-slate-100", className)}>
      <path d="M3 4h18v3H3V4zm0 6h18v3H3v-3zm0 6h12v3H3v-3z" />
    </svg>
  );
}

/** Modal */
export function ModalLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#00D26A" className={cn("shrink-0", className)}>
      <path d="M4 4h4v16H4V4zm6 0h4v16h-4V4zm6 0h4v16h-4V4z" />
    </svg>
  );
}

/** Puter */
export function PuterLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="#0066FF" />
      <path d="M8 8h8v2H8V8zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" fill="#FFFFFF" />
    </svg>
  );
}

/** Hugging Face */
export function HuggingFaceLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="10" fill="#FFD21E" />
      <circle cx="8.5" cy="9.5" r="1.5" fill="#000000" />
      <circle cx="15.5" cy="9.5" r="1.5" fill="#000000" />
      <path d="M8 14.5c1.5 2 6.5 2 8 0" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Upstage Solar */
export function UpstageLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="5" fill="#FFB800" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" stroke="#FFB800" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** NVIDIA — Official green claw eye emblem */
export function NVIDIALogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#76B900" className={cn("shrink-0", className)}>
      <path d="M8.948 8.798v-1.43a7 7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851a3.7 3.7 0 0 1-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6 6 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964a6.5 6.5 0 0 1-1.095-.097v1.325c.3.035.61.062.91.062c3.957 0 6.82-2.023 9.593-4.408c.459.371 2.34 1.263 2.73 1.652c-2.633 2.208-8.772 3.984-12.253 3.984c-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936" />
    </svg>
  );
}

/** Meta / Llama */
export function MetaLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#0081FB" className={cn("shrink-0", className)}>
      <path d="M16.94 4.5c-2.32 0-4.4 1.2-5.64 3.08A7.26 7.26 0 0 0 5.66 4.5C2.54 4.5 0 7.04 0 10.16c0 4.18 4.28 8.04 8.44 11.08a4.96 4.96 0 0 0 5.72 0c4.16-3.04 8.44-6.9 8.44-11.08 0-3.12-2.54-5.66-5.66-5.66zm-5.64 12.44c-2.88-2.24-5.92-5.2-5.92-7.78 0-1.6.14-2.84 2.84-2.84 2.08 0 3.76 1.48 4.6 3.4.84-1.92 2.52-3.4 4.6-3.4 2.7 0 2.84 1.24 2.84 2.84 0 2.58-3.04 5.54-5.92 7.78a2.16 2.16 0 0 1-3.04 0z" />
    </svg>
  );
}

/** Mistral AI */
export function MistralLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#FF7000" className={cn("shrink-0", className)}>
      <rect x="2" y="3" width="4" height="4" rx="0.5" />
      <rect x="18" y="3" width="4" height="4" rx="0.5" />
      <rect x="2" y="9" width="8" height="4" rx="0.5" />
      <rect x="14" y="9" width="8" height="4" rx="0.5" />
      <rect x="2" y="15" width="20" height="4" rx="0.5" />
    </svg>
  );
}

/** Microsoft / Phi */
export function MicrosoftLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("shrink-0", className)}>
      <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
    </svg>
  );
}

/** MiniMax — Blue circle emblem */
export function MiniMaxLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="#2563EB" />
      <path d="M7 14.5l3-5 2.5 3.5 2-2.5 2.5 4" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Cohere */
export function CohereLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D18267" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** Qwen / Alibaba — Blue star emblem */
export function QwenLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="#2563EB" />
      <path d="M12 6.5l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" fill="#FFFFFF" />
    </svg>
  );
}

/** StepFun */
export function StepFunLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#00C4CC" className={cn("shrink-0", className)}>
      <path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.5l5.5 3.4L12 11.4 6.5 7.9 12 4.5z" />
    </svg>
  );
}

/** Writer */
export function WriterLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#8B5CF6" className={cn("shrink-0", className)}>
      <path d="M4 4h16v16H4V4zm4 4v8h2V8H8zm4 0v8h4v-2h-2V8h-2z" />
    </svg>
  );
}

/** OpenCode Zen — Official OpenCode emblem */
export function OpenCodeLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={cn("shrink-0 text-blue-600 dark:text-blue-400", className)}>
      <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </svg>
  );
}

/** Allam — Saudi AI model emblem */
export function AllamLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="#007A3D" />
      <path d="M12 6v10M9 9c1.5-1.5 4.5-1.5 6 0M9 13c1.5-1.5 4.5-1.5 6 0" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Orpheus — Voice/Audio model emblem */
export function OrpheusLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="#8B5CF6" />
      <path d="M8 15V9l7-2v6M8 12l7-2" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="15" r="1.5" fill="#FFFFFF" />
      <circle cx="13.5" cy="13" r="1.5" fill="#FFFFFF" />
    </svg>
  );
}

/** Compound AI emblem */
export function CompoundLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn("shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="#0D9488" />
      <circle cx="8.5" cy="9.5" r="2" fill="#FFFFFF" />
      <circle cx="15.5" cy="9.5" r="2" fill="#FFFFFF" />
      <circle cx="12" cy="15.5" r="2" fill="#FFFFFF" />
    </svg>
  );
}

const BRAND_LOGO = {
  meta: MetaLogo,
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  google: GoogleLogo,
  deepseek: DeepSeekLogo,
  zhipu: ZhipuLogo,
  kimi: KimiLogo,
  grok: GrokLogo,
  groq: GroqLogo,
  together: TogetherLogo,
  perplexity: PerplexityLogo,
  siliconflow: SiliconFlowLogo,
  yi: YiLogo,
  mistral: MistralLogo,
  microsoft: MicrosoftLogo,
  minimax: MiniMaxLogo,
  cohere: CohereLogo,
  qwen: QwenLogo,
  stepfun: StepFunLogo,
  writer: WriterLogo,
  nvidia: NVIDIALogo,
  doubao: DoubaoLogo,
  ernie: ErnieLogo,
  hunyuan: HunyuanLogo,
  baichuan: BaichuanLogo,
  sarvam: SarvamLogo,
  upstage: UpstageLogo,
  fireworks: FireworksLogo,
  deepinfra: DeepInfraLogo,
  sambanova: SambaNovaLogo,
  cerebras: CerebrasLogo,
  replicate: ReplicateLogo,
  modal: ModalLogo,
  puter: PuterLogo,
  huggingface: HuggingFaceLogo,
  opencode: OpenCodeLogo,
  allam: AllamLogo,
  orpheus: OrpheusLogo,
  compound: CompoundLogo,
} as const satisfies Record<Exclude<Brand, "neutral">, ComponentType<ProviderLogoProps>>;

/**
 * Central Provider & Model Logo Component.
 * Resolves a brand deterministically (see `src/lib/brands.ts`) and renders
 * its SVG. Pass `brand` to force a specific logo; otherwise `providerId` /
 * `modelId` are resolved automatically. Unknown brands render a neutral icon.
 */
export function ProviderLogo({ providerId, modelId, brand, size = 16, className }: ProviderLogoProps) {
  const resolved = brand ?? resolveBrand(providerId, modelId);
  const Logo = resolved === "neutral" ? undefined : BRAND_LOGO[resolved];
  if (!Logo) {
    return <Cpu size={size} className={cn("shrink-0 text-muted-foreground", className)} />;
  }
  return <Logo size={size} className={className} />;
}
