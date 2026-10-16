import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { DEFAULT_FONT_SIZE, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_KEY } from "@/lib/font";
import { SUPPORTED_LANGUAGE_CODES, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "HermOS IDE",
  description: "An agentic IDE for software teams.",
  authors: [{ name: "HermOS" }],
  icons: {
    icon: "/favicon.svg",
  },
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {/*
          Theme/language anti-FOUC bootstrap. Deliberately a RAW <script>
          as the FIRST child of <body> — not in a manual <head>, not
          next/script:
          - next/script is a client component ('use client' in
            dist/client/script.js): it fresh-mounts a <script> host on
            every client render, and React 19 dev flags ANY client-mounted
            script ("Encountered a script tag...", twice observed).
          - a manual <head> is worse: Next manages <head> itself
            (streaming/de-dup per the layout docs), so head children get
            re-created on the client — same overlay.
          Body children hydrate in place with no manager interference, and
          a parser-inserted script at body start still executes before any
          content below it paints. Language allowlist + storage key are
          generated from the single source in lib/i18n; values are
          allowlisted so garbage localStorage never sets lang=xx — hydrate
          corrects via applyLanguageDocumentDir.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("theme")||"system";var r=t==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):t;var root=document.documentElement;root.classList.remove("light","dark");root.classList.add(r);root.style.colorScheme=r;var fs=localStorage.getItem(${JSON.stringify(FONT_SIZE_KEY)});var n=fs?parseInt(fs,10):${DEFAULT_FONT_SIZE};root.style.fontSize=(!isNaN(n)&&n>=${FONT_SIZE_MIN}&&n<=${FONT_SIZE_MAX}?n:${DEFAULT_FONT_SIZE})+"px";var al=${JSON.stringify(SUPPORTED_LANGUAGE_CODES)};var l=localStorage.getItem(${JSON.stringify(LANGUAGE_STORAGE_KEY)})||"en";if(al.indexOf(l)===-1){l="en";}root.setAttribute("lang",l);if(l==="ar"){root.setAttribute("dir","rtl");root.classList.add("rtl");}else{root.setAttribute("dir","ltr");root.classList.remove("rtl");}}catch(e){}`,
          }}
        />
        <Providers>
          {children}
          <SonnerToaster position="top-center" closeButton toastOptions={{ style: { background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)" } }} />
        </Providers>
      </body>
    </html>
  );
}
