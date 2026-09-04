; HermOS IDE NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
; Compiled into every NSIS installer: fresh installs, manual reinstalls, and
; updater-driven silent updates.
;
; Why this exists: the app runs a Node sidecar from inside the install dir.
; If a previous instance (or an orphaned sidecar) is still alive when the
; installer replaces files, Windows file locks make the update silently abort
; and the user reopens the old version with zero signal. Killing by image
; name (node.exe) would be hostile system-wide, so this is strictly scoped to
; processes whose executable path lives under $INSTDIR — i.e. only our files.

!macro NSIS_HOOK_PREINSTALL
  ; Best-effort: a fresh install has no processes to kill; failures here must
  ; never block installation, so every step swallows errors.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith("$INSTDIR", [System.StringComparison]::OrdinalIgnoreCase) } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue }"'
  Pop $0 ; nsExec pushes its return value — keep the stack balanced
  Sleep 1500 ; let killed processes release their file handles
!macroend
