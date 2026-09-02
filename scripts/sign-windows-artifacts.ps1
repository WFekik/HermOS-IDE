# Mandatory Automated Windows binary signing via official SignPath PowerShell Module for CI release pipelines.
# Packages installer binaries into a temporary zip, submits to SignPath, and extracts signed binaries in-place.
# BLOCKS release if signing fails.

param(
    [string]$ApiToken = $env:SIGNPATH_API_TOKEN,
    [string]$OrganizationId = $(if ($env:SIGNPATH_ORGANIZATION_ID) { $env:SIGNPATH_ORGANIZATION_ID } else { "1390df68-6835-4914-86af-c378938047b4" }),
    [string]$ProjectSlug = $(if ($env:SIGNPATH_PROJECT_SLUG) { $env:SIGNPATH_PROJECT_SLUG } else { "HermOS-IDE" }),
    [string]$PolicySlug = $(if ($env:SIGNPATH_POLICY_SLUG) { $env:SIGNPATH_POLICY_SLUG } else { "Release_signing" }),
    [string]$ArtifactConfigurationSlug = $(if ($env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG) { $env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG } else { "initial-version" })
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

$tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "HermOS_SignPath_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    foreach ($file in $targetFiles) {
        Write-Host "`n[SignPath] Packaging $($file.Name) into signing container..."
        $inputZip = [System.IO.Path]::Combine($tempDir, "input_$($file.Name).zip")
        $outputZip = [System.IO.Path]::Combine($tempDir, "output_$($file.Name).zip")
        $extractDir = [System.IO.Path]::Combine($tempDir, "extract_$($file.Name)")

        Compress-Archive -Path $file.FullName -DestinationPath $inputZip -Force

        Write-Host "[SignPath] Submitting $($file.Name) container to SignPath..."
        try {
            Submit-SigningRequest -InputArtifactPath $inputZip -ApiToken $ApiToken -OrganizationId $OrganizationId -ProjectSlug $ProjectSlug -SigningPolicySlug $PolicySlug -ArtifactConfigurationSlug $ArtifactConfigurationSlug -OutputArtifactPath $outputZip -WaitForCompletion -Force
        } catch {
            Write-Error "[SignPath] FATAL: Mandatory Authenticode signing failed for $($file.Name): $_"
            exit 1
        }

        Write-Host "[SignPath] Extracting signed $($file.Name) from container..."
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        Expand-Archive -Path $outputZip -DestinationPath $extractDir -Force

        $signedBinary = Get-ChildItem -Path $extractDir -Filter $file.Name -Recurse | Select-Object -First 1
        if (-not $signedBinary) {
            Write-Error "[SignPath] FATAL: Signed binary $($file.Name) was not found in returned SignPath archive."
            exit 1
        }

        Copy-Item -Path $signedBinary.FullName -Destination $file.FullName -Force
        Write-Host "[SignPath] Successfully verified and replaced $($file.Name) with Authenticode signed binary!"
    }
} finally {
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n[SignPath] All Windows artifacts successfully signed with Authenticode certificate."
exit 0
