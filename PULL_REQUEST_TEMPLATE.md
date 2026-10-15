# Pull Request

## What changed
<!-- One paragraph: user-visible behavior + files touched. -->

## Why
<!-- Link the issue or audit finding. -->

## Verification
<!-- Commands run and their result. Check all that apply. -->
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` green (or scoped: `npm test -- --run <files>`)
- [ ] `node scripts/version.mjs check` (only if version files touched — bump only via `node scripts/version.mjs bump`)

## Risk notes
<!-- Migrations, behavior changes, rollback plan. Note any new storage keys, API shapes, or Tauri capabilities. -->
