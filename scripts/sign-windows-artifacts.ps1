# Mandatory Automated Windows binary signing via official SignPath PowerShell Module for CI release pipelines.
# Packages installer binaries into a temporary zip container, submits to SignPath, and extracts signed binaries in-place.
# BLOCKS release if signing fails.

param(
    [string]$ApiToken = $env:SIGNPATH_API_TOKEN,
    [string]$OrganizationId = $(if ($env:SIGNPATH_ORGANIZATION_ID -and -not $env:SIGNPATH_ORGANIZATION_ID.StartsWith("$(")) { $env:SIGNPATH_ORGANIZATION_ID } else { "1390df68-6835-4914-86af-c378938047b4" }),
    [string]$ProjectSlug = $(if ($env:SIGNPATH_PROJECT_SLUG -and -not $env:SIGNPATH_PROJECT_SLUG.StartsWith("$(")) { $env:SIGNPATH_PROJECT_SLUG } else { "HermOS-IDE" }),
    [string]$PolicySlug = $(if ($env:SIGNPATH_POLICY_SLUG -and -not $env:SIGNPATH_POLICY_SLUG.StartsWith("$(")) { $env:SIGNPATH_POLICY_SLUG } else { "Release_signing" })
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
    Write-Host "`n[SignPath] Packaging $($file.Name) into zip container for SignPath..."
    $safeName = $file.Name -replace '[^a-zA-Z0-9_\-\.]', '_'
    $tempZipIn = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "sp_in_$safeName.zip")
    $tempZipOut = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "sp_out_$safeName.zip")
    $extractDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "sp_ext_$safeName")

    try {
        if (Test-Path $tempZipIn) { Remove-Item $tempZipIn -Force -ErrorAction SilentlyContinue }
        if (Test-Path $tempZipOut) { Remove-Item $tempZipOut -Force -ErrorAction SilentlyContinue }
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue }

        # Create zip container containing the binary
        Compress-Archive -Path $file.FullName -DestinationPath $tempZipIn -Force

        Write-Host "[SignPath] Submitting $($file.Name) container to SignPath for Authenticode signing..."
        Submit-SigningRequest `
            -InputArtifactPath $tempZipIn `
            -ApiToken $ApiToken `
            -OrganizationId $OrganizationId `
            -ProjectSlug $ProjectSlug `
            -SigningPolicySlug $PolicySlug `
            -OutputArtifactPath $tempZipOut `
            -WaitForCompletion `
            -Force

        if (Test-Path $tempZipOut) {
            Write-Host "[SignPath] Extracting signed binary from container..."
            New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
            Expand-Archive -Path $tempZipOut -DestinationPath $extractDir -Force

            $signedBinary = Get-ChildItem -Path $extractDir -Filter $file.Name -Recurse | Select-Object -First 1
            if ($signedBinary) {
                Copy-Item -Path $signedBinary.FullName -Destination $file.FullName -Force
                Write-Host "[SignPath] Successfully signed and replaced $($file.Name) with Authenticode signed binary!"
            } else {
                Write-Error "[SignPath] FATAL: Could not find $($file.Name) in returned container archive."
                exit 1
            }
        }
    } catch {
        Write-Error "[SignPath] FATAL: Mandatory Authenticode signing failed for $($file.Name): $_"
        exit 1
    } finally {
        if (Test-Path $tempZipIn) { Remove-Item $tempZipIn -Force -ErrorAction SilentlyContinue }
        if (Test-Path $tempZipOut) { Remove-Item $tempZipOut -Force -ErrorAction SilentlyContinue }
        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "`n[SignPath] All Windows artifacts successfully signed with Authenticode certificate."
exit 0
