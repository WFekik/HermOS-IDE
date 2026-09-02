# Mandatory Automated Windows binary signing via official SignPath PowerShell Module for CI release pipelines.
# Signs installer binaries in-place using official SignPath CI configuration.
# BLOCKS release if signing fails.

param(
    [string]$ApiToken = $env:SIGNPATH_API_TOKEN,
    [string]$OrganizationId = $(if ($env:SIGNPATH_ORGANIZATION_ID) { $env:SIGNPATH_ORGANIZATION_ID } else { "1390df68-6835-4914-86af-c378938047b4" }),
    [string]$ProjectSlug = $(if ($env:SIGNPATH_PROJECT_SLUG) { $env:SIGNPATH_PROJECT_SLUG } else { "HermOS-IDE" }),
    [string]$PolicySlug = $(if ($env:SIGNPATH_POLICY_SLUG) { $env:SIGNPATH_POLICY_SLUG } else { "Release_signing" })
)

if (-not $ApiToken) {
    Write-Error "[SignPath] FATAL: SIGNPATH_API_TOKEN is not configured! Mandatory Windows code signing cannot proceed."
    exit 1
}

Write-Host "[SignPath] Installing and loading official SignPath PowerShell module..."
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Set-PSRepository -Name 'PSGallery' -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    Install-Module -Name SignPath -Force -Scope CurrentUser -Repository PSGallery -ErrorAction Stop
    Import-Module SignPath -ErrorAction Stop
    Write-Host "[SignPath] Module loaded successfully."
} catch {
    Write-Error "[SignPath] FATAL: Failed to install or import SignPath PowerShell module: $_"
    exit 1
}

$bundleDirs = @(
    "src-tauri/target/release/bundle/nsis",
    "src-tauri/target/release/bundle/msi"
)

$targetFiles = @()
foreach ($dir in $bundleDirs) {
    if (Test-Path $dir) {
        $found = Get-ChildItem -Path $dir -Include *.exe, *.msi -Recurse
        if ($found) {
            $targetFiles += $found
        }
    }
}

if ($targetFiles.Count -eq 0) {
    Write-Error "[SignPath] FATAL: No Windows installer files (.exe or .msi) found to sign."
    exit 1
}

Write-Host "[SignPath] Found $($targetFiles.Count) Windows binary installer(s) to sign."

foreach ($file in $targetFiles) {
    Write-Host "`n[SignPath] Submitting $($file.Name) to SignPath for mandatory Authenticode signing..."
    try {
        Submit-SigningRequest `
            -InputArtifactPath $file.FullName `
            -ApiToken $ApiToken `
            -OrganizationId $OrganizationId `
            -ProjectSlug $ProjectSlug `
            -SigningPolicySlug $PolicySlug `
            -OutputArtifactPath $file.FullName `
            -WaitForCompletion `
            -Force
        Write-Host "[SignPath] Successfully signed $($file.Name) with Authenticode certificate!"
    } catch {
        Write-Error "[SignPath] FATAL: Mandatory Authenticode signing failed for $($file.Name): $_"
        exit 1
    }
}

Write-Host "`n[SignPath] All Windows artifacts successfully signed with Authenticode certificate."
exit 0
