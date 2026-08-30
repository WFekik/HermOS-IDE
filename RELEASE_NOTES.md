# Release Notes — HermOS IDE v1.0.3

**Release Date:** August 30, 2026  
**Tag:** `v1.0.3`  
**Platforms:** Windows (`.msi`, `.exe`), macOS (`.dmg`, `.app`), Linux (`.deb`, `.AppImage`)

---

## Highlights & Major Improvements

### 🛡️ Permissions & Security Subsystem
- **Canonical Action Synchronization**: Eliminated schema drift between API endpoints and permission models by deriving validation schemas directly from `KNOWN_PERMISSION_ACTIONS` (resolving the `"Invalid permissions config"` toast when saving settings).
- **Fast In-Memory Evaluations**: `batchPermConfig` evaluates rules in `<0.001ms` in-memory and instantly propagates `"Always Allow"` choices across remaining tools in the same turn without querying SQLite repeatedly.

### 🧠 Agent Execution & Convergence Detection
- **Output Loop Prevention**: Implemented `ConvergenceDetector` to detect cross-turn repetitive planning prose. Automatically strips duplicated text and injects system corrections (`[SYSTEM ERROR: Output loop detected...]`) on the 2nd repeat, then force-terminates with diagnostic output if unaddressed by the 3rd repeat.
- **Configurable Global Safety Ceiling**: Added `HERMOS_MAX_AGENT_ITERATIONS` environment variable (defaults to `Infinity` to preserve autonomous behavior, customizable per deployment).

### ⚡ Real-Time Streaming & UI Responsiveness
- **Interleaved Tool Pipeline**: Converted the legacy 3-pass tool execution pipeline into an interleaved pipeline. Each file operation is permission-evaluated, emitted, executed, and settled in chronological sequence, eliminating UI freezes during multi-file edits.
- **Responsive Large File Writes**: Stream hold-back limit is now configurable via `HERMOS_STREAM_BUFFER_LIMIT` (default 100,000 chars), eliminating multi-second UI text pauses during large file writes.
- **Tab Switch Resilience**: Added immediate event flushing (`flushPending()`) on window visibility regain, ensuring accepted commands and completed tool cards render immediately when returning to the tab.

### 🔄 Checkpoints & Multi-Turn Undo Engine
- **Windows NTFS Path Sanitization**: Rewrote `getSafeRelativePath` to eliminate illegal drive colons (`:`) in snapshot paths (mapping drive letters to `drive-<Letter>`), fixing silent checkpoint failures and restoring reliable multi-turn file rollbacks on Windows.
- **Disk Storage Optimization**: Added `deleteConversationCheckpoints` to automatically and recursively delete on-disk checkpoint snapshot folders when conversations are deleted individually or in bulk.

---

## Upgrade & Verification

- **TypeScript Typecheck**: 0 errors (`tsc --noEmit`)
- **Test Suite**: 86 test suites passed (1,493 tests)
- **Production Bundle**: Next.js Turbopack standalone build compiled with 0 errors and 0 warnings
