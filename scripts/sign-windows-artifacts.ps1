# Automated Windows binary signing via official SignPath PowerShell Module for CI release pipelines.
# Replaces un-signed bundle .exe and .msi files with trusted Authenticode signed versions.

param(
    [string]$ApiToken = $env:SIGNPATH_API_TOKEN,
    [string]$OrganizationId = $(if ($env:SIGNPATH_ORGANIZATION_ID) { $env:SIGNPATH_ORGANIZATION_ID } else { "1390df68-6835-4914-86af-c378938047b4" }),
    [string]$ProjectSlug = $(if ($env:SIGNPATH_PROJECT_SLUG) { $env:SIGNPATH_PROJECT_SLUG } else { "HermOS-IDE" }),
    [string]$PolicySlug = $(if ($env:SIGNPATH_POLICY_SLUG) { $env:SIGNPATH_POLICY_SLUG } else { "Release_signing" })
)

if (-not $ApiToken) {
    Write-Host "[SignPath] SIGNPATH_API_TOKEN not configured - skipping automated Windows code signing."
    exit 0
}

Write-Host "[SignPath] Installing and loading official SignPath PowerShell module..."
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Set-PSRepository -Name 'PSGallery' -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    Install-Module -Name SignPath -Force -Scope CurrentUser -Repository PSGallery -ErrorAction Stop
    Import-Module SignPath -ErrorAction Stop
    Write-Host "[SignPath] Module loaded successfully."
} catch {
    Write-Warning "[SignPath] Failed to install/import SignPath PowerShell module: $_"
    exit 0
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
    Write-Host "[SignPath] No Windows .exe / .msi installer files found to sign."
    exit 0
}

Write-Host "[SignPath] Found $($targetFiles.Count) Windows binary installer(s) to sign."

foreach ($file in $targetFiles) {
    Write-Host "`n[SignPath] Submitting $($file.Name) to SignPath for Authenticode signing..."
    try {
        Submit-SigningRequest -InputArtifactPath $file.FullName -ApiToken $ApiToken -OrganizationId $OrganizationId -ProjectSlug $ProjectSlug -SigningPolicySlug $PolicySlug -OutputArtifactPath $file.FullName -WaitForCompletion
        Write-Host "[SignPath] Successfully signed $($file.Name) with Authenticode certificate!"
    } catch {
        Write-Warning "[SignPath] Signing failed for $($file.Name): $_"
        Write-Warning "[SignPath] Continuing release pipeline with built installer."
    }
}

Write-Host "`n[SignPath] Windows signing step completed."
exit 0
