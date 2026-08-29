import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: true,
  distDir: ".next-build",
  // Prisma ships `turbopackIgnore: true`, so Turbopack would otherwise bundle
  // the client and its dynamic requires would resolve against the BUILD
  // machine's node_modules at runtime (breaking portability and re-reading the
  // dev repo's .env via Prisma's dotenv loader). Marking these external forces
  // runtime `require()` against the standalone's own node_modules, where
  // scripts/nextjs-build.mjs copies them.
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/engines",
    ".prisma/client",
  ],
  // The standalone output is bundled wholesale into the desktop installer
  // (tauri.conf.json resources), so the trace must NEVER include dev/test
  // artifacts, the repo's own sources, or heavy build dirs. `prisma/` and
  // `public/` are re-copied explicitly by scripts/nextjs-build.mjs.
  outputFileTracingRoot: __dirname,
  outputFileTracingExcludes: {
    "*": [
      ".git/**",
      // NOTE: `.next-build/**` must NOT be excluded — with `distDir:
      // ".next-build"` the standalone's own runtime dist lives at
      // `<standalone>/.next-build/` (server chunks, manifests, static/).
      // Only exclude the repo-root artifacts traced alongside it.
      "src/**",
      "tests/**",
      "src/test/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "scripts/**",
      "hermos-website/**",
      "src-tauri/**",
      "public/**",
      "prisma/**",
      "*.log",
      ".env*",
      "eslint.config.mjs",
      "tailwind.config.ts",
      "postcss.config.mjs",
      "components.json",
      "vitest.config.ts",
      "vitest.perf.config.ts",
      "tsconfig.json",
      "next-env.d.ts",
      "package-lock.json",
      "README.md",
      "LICENSE",
      "AGENTS.md",
      "dev_start.bat",
      "dev_start.sh",
      ".gitattributes",
      ".gitignore",
    ],
  },
  async headers() {
    return [
      {
        // Apply strict IDE CSP to all routes EXCEPT the sandboxed browser proxy
        source: "/((?!api/browser/proxy).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              // Local-first IDE note: the app is served over loopback HTTP and
              // the CSP must keep working inside the Tauri WebView
              // (http://tauri.localhost / tauri://localhost) as well as a
              // plain browser tab. `report-uri`/`report-to` are deliberately
              // OMITTED — there is no remote CSP-report collector, and a
              // loopback reporter would only swallow telemetry; violations
              // are observable in the WebView/browser console instead.
              "upgrade-insecure-requests",
              // blob: required for Monaco editor and local resource previews
              isProd ? "img-src 'self' data: blob:" : "img-src 'self' data: blob: https:",
              // prod: providers are only ever called from the server (API
              // routes), so the page needs nothing beyond same-origin + ws
              // (SSE streams). dev: Next.js hot-reload + Monaco workers talk
              // to the loopback dev server and local AI servers (Ollama etc.),
              // so allow ws/http on loopback only — no arbitrary https:.
              isProd
                ? "connect-src 'self' ws: wss:"
                : "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:* http://localhost:* http://127.0.0.1:* http://[::1]:*",
              "font-src 'self' data:",
              // SSR'd components emit inline styles (resizable panels, framer-motion)
              "style-src 'self' 'unsafe-inline'",
              // script-src: `'unsafe-inline'` is REQUIRED — Next.js injects an
              // inline bootstrap script (RSC payload) and Monaco's Web Worker
              // is loaded from a blob: URL, so a hash/nonce-only policy is not
              // achievable without forking Next's rendering pipeline.
              // `wasm-unsafe-eval` (prod) / `unsafe-eval` (dev) are needed for
              // the Monaco editor's WebAssembly + language-service eval.
              // This is a documented residual risk for a local-first IDE; the
              // app's attack surface is reduced elsewhere (Host/Origin checks,
              // SSRF policy, CSP frame/connect restrictions).
              isProd
                ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
                : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "worker-src 'self' blob:",
            ].join("; "),
          },
        ],
      },
      {
        // The headless browser proxy serves third-party HTML in an iframe.
        // The proxy route handler itself sets the authoritative CSP headers.
        source: "/api/browser/proxy",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value:
              "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline' data: blob:; font-src * data: blob:; img-src * data: blob: https: http:; media-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src *;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
