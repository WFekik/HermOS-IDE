import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TODO(public-launch): Many rules are currently "off" for velocity during
    // pre-launch development. Before a public 1.0, re-enable incrementally as
    // warnings — at minimum "@typescript-eslint/no-explicit-any" (as "warn"),
    // "@typescript-eslint/no-unused-vars" (as "warn" with argsIgnorePattern),
    // and "react-hooks/exhaustive-deps" (as "warn") — then fix the resulting
    // warnings file-by-file. Keeping them "off" globally now is intentional to
    // avoid a noisy launch blocker, but should not remain permanently disabled.
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "warn",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/immutability": "off",
    "react-hooks/incompatible-library": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "warn",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "error",
    "no-empty": ["warn", { "allowEmptyCatch": true }],
    "no-irregular-whitespace": "warn",
    "no-case-declarations": "off",
    "no-fallthrough": "warn",
    "no-mixed-spaces-and-tabs": "warn",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "error",
    "no-useless-escape": "off",
  },
}, {
  files: ["scripts/**/*.js", "hermos-website/**/*.cjs"],
  rules: {
    // Plain-Node CJS scripts — no "type": "module" in package.json,
    // so require() is required for runtime compatibility.
    "@typescript-eslint/no-require-imports": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", ".next-build/**", "out/**", "build/**", "src-tauri/**", "next-env.d.ts", "examples/**", "skills"]
}];

export default eslintConfig;
