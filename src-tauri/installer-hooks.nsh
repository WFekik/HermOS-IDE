; HermOS IDE — NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
;
; Problem: on Windows the installer cannot replace node.exe or loaded *.node
; modules while the app is still running, so NSIS dies with "Error opening
; file for writing" (Abort/Retry/Ignore) and can leave a half-updated tree
; behind. These hooks close that hole at the installer level, complementing
; the in-app pre-install lock probe (which aborts auto-update before NSIS
; ever spawns when files are still locked):
;
; - NSIS_HOOK_PREINSTALL: refuse to copy files while HermOS IDE.exe is alive.
;   The user is asked to close the app (graceful — no data loss) with
;   Retry/Cancel; Cancel aborts the install cleanly before anything is
;   replaced. Closing the app also stops its Node sidecar (the Rust exit
;   handler reaps it), which releases node.exe + the *.node modules.
; - NSIS_HOOK_PREUNINSTALL: same guard before removing files.
;
; Detection uses only stock facilities: tasklist + findstr via nsExec.
; findstr exits 0 on match / 1 on no match, so the check is
; locale-independent — we never match on tasklist's localized "no tasks"
; text, only on findstr's exit code. The regex anchors both names in CSV
; quotes (`"app.exe","`) so a substring can never false-positive (e.g. a
; user's `whatsapp.exe` must not block/phantom-match an install).
; No third-party NSIS plugins, no !includes:
; this file must compile inside Tauri's generated installer.nsi as-is
; (labels are Hermos-prefixed to avoid collisions with the template).
; Silent installs skip the prompt (IfSilent) and keep prior behavior.
;
; Deliberately main-exe-first: closing the app also stops its managed Node
; sidecar via the Rust exit handler, which releases node.exe + the *.node
; modules. A leftover sidecar with no live UI (crash orphan, or a second
; install location's node) is swept below, scoped to $INSTDIR only — a
; user's own Node elsewhere is never touched. Prompting on every node.exe
; would nag developers with unrelated Node processes on every install.
;
; NOTE: the main binary is `app.exe` (Cargo package name — NOT productName,
; which only labels the installer/window). Both spellings are checked: the
; HermOS IDE.exe arm covers a future rename. If the binary is ever renamed,
; update BOTH the tasklist line and the Rust sibling check (own_name).

!macro NSIS_HOOK_PREINSTALL
  ; Pushes come FIRST: the IfSilent jump lands past them, and every path
  ; below (check loop, clear, Cancel/Abort) must leave the stack balanced.
  Push $0
  Push $1
  Push $2
  IfSilent HermosPreInstall_Clear
  StrCpy $2 0
  HermosPreInstall_Check:
    nsExec::ExecToStack 'cmd /c tasklist /FO CSV /NH | findstr /R /I /C:"\"app\.exe\"," /C:"\"HermOS IDE\.exe\","'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 HermosPreInstall_Clear
    ; If app is still exiting (e.g. updater just launched us), give it up to 2.5s (5 x 500ms) before prompting
    IntOp $2 $2 + 1
    IntCmp $2 5 HermosPreInstall_Prompt HermosPreInstall_Sleep HermosPreInstall_Prompt
  HermosPreInstall_Sleep:
    Sleep 500
    Goto HermosPreInstall_Check
  HermosPreInstall_Prompt:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "HermOS IDE is still running.$\n$\nPlease close it (all windows) so the installer can replace its files. No uninstall is needed.$\n$\nChoose Retry after closing the app, or Cancel to stop the installer." IDRETRY HermosPreInstall_Reset
    Pop $2
    Pop $1
    Pop $0
    Abort "Installation cancelled: HermOS IDE was still running."
  HermosPreInstall_Reset:
    StrCpy $2 0
    Goto HermosPreInstall_Check
  HermosPreInstall_Clear:
    ; No live UI remains past this point, so any node.exe under $INSTDIR is
    ; a true orphan (crash leftover) holding .node modules NSIS must
    ; replace — stop it scoped to this install dir. Best-effort: any
    ; failure falls through to the previous behavior (NSIS copy errors).
    ; ($INSTDIR is passed via HERMOS_INSTDIR env var to eliminate quoting/escaping bugs.)
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMOS_INSTDIR", t "$INSTDIR")'
    nsExec::ExecToStack "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Get-CimInstance Win32_Process -Filter 'Name = ''node.exe'' OR Name LIKE ''node-%''' | Where-Object { ($$_.ExecutablePath -and $$_.ExecutablePath -like ('*' + $$env:HERMOS_INSTDIR + '*')) -or ($$_.CommandLine -and $$_.CommandLine -like ('*' + $$env:HERMOS_INSTDIR + '*')) } | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch { } }; Start-Sleep -Milliseconds 800$\""
    Pop $0
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMOS_INSTDIR", p 0)'
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same stack discipline as PREINSTALL: push first, IfSilent lands past.
  Push $0
  Push $1
  Push $2
  IfSilent HermosPreUninstall_Clear
  StrCpy $2 0
  HermosPreUninstall_Check:
    nsExec::ExecToStack 'cmd /c tasklist /FO CSV /NH | findstr /R /I /C:"\"app\.exe\"," /C:"\"HermOS IDE\.exe\","'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 HermosPreUninstall_Clear
    IntOp $2 $2 + 1
    IntCmp $2 5 HermosPreUninstall_Prompt HermosPreUninstall_Sleep HermosPreUninstall_Prompt
  HermosPreUninstall_Sleep:
    Sleep 500
    Goto HermosPreUninstall_Check
  HermosPreUninstall_Prompt:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "HermOS IDE is still running.$\n$\nPlease close it (all windows) so the uninstaller can remove its files.$\n$\nChoose Retry after closing the app, or Cancel to stop the uninstaller." IDRETRY HermosPreUninstall_Reset
    Pop $2
    Pop $1
    Pop $0
    Abort "Uninstallation cancelled: HermOS IDE was still running."
  HermosPreUninstall_Reset:
    StrCpy $2 0
    Goto HermosPreUninstall_Check
  HermosPreUninstall_Clear:
    ; Same orphan sweep as install (scoped to $INSTDIR, best-effort).
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMOS_INSTDIR", t "$INSTDIR")'
    nsExec::ExecToStack "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Get-CimInstance Win32_Process -Filter 'Name = ''node.exe'' OR Name LIKE ''node-%''' | Where-Object { ($$_.ExecutablePath -and $$_.ExecutablePath -like ('*' + $$env:HERMOS_INSTDIR + '*')) -or ($$_.CommandLine -and $$_.CommandLine -like ('*' + $$env:HERMOS_INSTDIR + '*')) } | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch { } }; Start-Sleep -Milliseconds 800$\""
    Pop $0
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMOS_INSTDIR", p 0)'
  Pop $2
  Pop $1
  Pop $0
!macroend
