/**
 * Platform detection helpers — single source of truth for platform checks.
 * Used across the IDE to adapt keyboard shortcuts, UI controls, and available terminal shells.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform = (navigator as unknown as { platform?: string }).platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac/.test(ua);
}

export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as unknown as { platform?: string }).platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Win/.test(platform) || /Windows/.test(ua);
}

export function isLinuxPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as unknown as { platform?: string }).platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Linux/.test(platform) || /X11/.test(ua);
}

export type PlatformShell = "bash" | "pwsh" | "cmd" | "zsh";

export interface ShellOption {
  value: PlatformShell;
  label: string;
  description: string;
}

/**
 * Returns available terminal shells filtered for the current operating system.
 * - Windows: pwsh, cmd, bash
 * - macOS: zsh, bash, pwsh
 * - Linux: bash, zsh, pwsh
 */
export function getPlatformShells(): ShellOption[] {
  if (isWindowsPlatform()) {
    return [
      { value: "pwsh", label: "PowerShell", description: "pwsh / PowerShell Core" },
      { value: "cmd", label: "Command Prompt", description: "cmd.exe" },
      { value: "bash", label: "Git Bash", description: "bash (WSL / Git for Windows)" },
    ];
  }
  if (isMacPlatform()) {
    return [
      { value: "zsh", label: "Zsh", description: "Default macOS shell" },
      { value: "bash", label: "Bash", description: "Bourne Again Shell" },
      { value: "pwsh", label: "PowerShell", description: "PowerShell Core" },
    ];
  }
  return [
    { value: "bash", label: "Bash", description: "Default Linux shell" },
    { value: "zsh", label: "Zsh", description: "Z shell" },
    { value: "pwsh", label: "PowerShell", description: "PowerShell Core" },
  ];
}

/**
 * Returns the recommended default shell for the current operating system.
 */
export function getDefaultShell(): PlatformShell {
  if (isWindowsPlatform()) return "pwsh";
  if (isMacPlatform()) return "zsh";
  return "bash";
}

