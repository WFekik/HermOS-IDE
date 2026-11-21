import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const STORE_IDENTITY = {
  name: 'walidfekik.HermOSIDE',
  publisher: 'CN=57802A88-72D0-4457-AE13-9703FE1B3C09',
  publisherDisplayName: 'walid fekik',
  displayName: 'HermOS IDE',
  appId: 'HermOSIDE',
  executable: 'app.exe',
};

export function getMsixVersion(semver) {
  const clean = String(semver || '').trim().replace(/^v/i, '');
  const parts = clean.split('.');
  const major = parts[0] || '1';
  const minor = parts[1] || '0';
  const patch = parts[2] ? parts[2].split('-')[0] : '0';
  return `${major}.${minor}.${patch}.0`;
}

export function generateAppxManifest({
  version,
  identity = STORE_IDENTITY,
}) {
  const msixVersion = getMsixVersion(version);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="${identity.name}"
    Publisher="${identity.publisher}"
    Version="${msixVersion}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${identity.displayName}</DisplayName>
    <PublisherDisplayName>${identity.publisherDisplayName}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Applications>
    <Application Id="${identity.appId}"
      Executable="${identity.executable}"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${identity.displayName}"
        Description="HermOS IDE - Next-generation agentic AI software engineering IDE"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" Square310x310Logo="Assets\\Square310x310Logo.png">
          <uap:ShowNameOnTiles>
            <uap:ShowOn Tile="square150x150Logo" />
            <uap:ShowOn Tile="wide310x150Logo" />
            <uap:ShowOn Tile="square310x310Logo" />
          </uap:ShowNameOnTiles>
        </uap:DefaultTile>
      </uap:VisualElements>
    </Application>
  </Applications>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>`;
}

export function findMakeAppx() {
  if (process.env.MAKEAPPX_PATH && fs.existsSync(process.env.MAKEAPPX_PATH)) {
    return process.env.MAKEAPPX_PATH;
  }

  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (fs.existsSync(sdkRoot)) {
    const versions = fs.readdirSync(sdkRoot).filter(v => /^10\.\d+\.\d+\.\d+$/.test(v)).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(sdkRoot, v, 'x64', 'makeappx.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return 'makeappx.exe';
}

export async function stageVisualAssets(targetAssetsDir, iconsDir = path.join(ROOT_DIR, 'src-tauri', 'icons')) {
  fs.mkdirSync(targetAssetsDir, { recursive: true });

  const directCopies = [
    'StoreLogo.png',
    'Square44x44Logo.png',
    'Square150x150Logo.png',
    'Square310x310Logo.png',
  ];

  for (const file of directCopies) {
    const src = path.join(iconsDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetAssetsDir, file));
    }
  }

  const iconSrc = path.join(iconsDir, 'icon.png');
  const wideDest = path.join(targetAssetsDir, 'Wide310x150Logo.png');
  if (fs.existsSync(iconSrc)) {
    const icon120 = await sharp(iconSrc).resize(120, 120).toBuffer();
    await sharp({
      create: {
        width: 310,
        height: 150,
        channels: 4,
        background: { r: 5, g: 10, b: 5, alpha: 1 },
      },
    }).composite([{ input: icon120, top: 15, left: 95 }]).png().toFile(wideDest);
  }
}

export function prepareStagingDirectory(stagingDir) {
  fs.mkdirSync(stagingDir, { recursive: true });

  const releaseDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');
  const appExe = path.join(releaseDir, 'app.exe');
  if (fs.existsSync(appExe)) {
    fs.copyFileSync(appExe, path.join(stagingDir, 'app.exe'));
  }

  const nodeCandidates = [
    path.join(ROOT_DIR, 'src-tauri', 'node-bin', 'node.exe'),
    path.join(ROOT_DIR, 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe'),
    path.join(releaseDir, 'node.exe'),
  ];
  for (const candidate of nodeCandidates) {
    if (fs.existsSync(candidate)) {
      fs.copyFileSync(candidate, path.join(stagingDir, 'node.exe'));
      break;
    }
  }

  const standaloneSrc = path.join(ROOT_DIR, '.next-build', 'standalone');
  if (fs.existsSync(standaloneSrc)) {
    const destUp = path.join(stagingDir, '_up_', '.next-build', 'standalone');
    fs.mkdirSync(path.dirname(destUp), { recursive: true });
    fs.cpSync(standaloneSrc, destUp, { recursive: true });
  }

  return stagingDir;
}

export async function packMsix({
  version,
  stagingDir,
  outputPath,
  makeAppxPath = findMakeAppx(),
}) {
  const manifestPath = path.join(stagingDir, 'AppxManifest.xml');
  const manifestXml = generateAppxManifest({ version });
  fs.writeFileSync(manifestPath, manifestXml, 'utf-8');

  await stageVisualAssets(path.join(stagingDir, 'Assets'));

  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });

  const args = ['pack', '/d', stagingDir, '/p', outputPath, '/o', '/nv'];
  const res = spawnSync(makeAppxPath, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`MakeAppx failed with exit code ${res.status}`);
  }

  return outputPath;
}

async function main() {
  if (process.argv[1] !== fileURLToPath(import.meta.url)) return;

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const outDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'bundle', 'msix');
  const outFile = path.join(outDir, `HermOS.IDE_${version}_x64.msix`);
  const stagingDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'msix-staging');

  console.log(`[msix] Packing HermOS IDE v${version} MSIX...`);
  console.log(`[msix] Staging directory: ${stagingDir}`);
  console.log(`[msix] Output target: ${outFile}`);

  if (!fs.existsSync(stagingDir)) {
    console.log(`[msix] Auto-assembling staging directory...`);
    prepareStagingDirectory(stagingDir);
  }

  await packMsix({ version, stagingDir, outputPath: outFile });
  console.log(`[msix] Successfully packed ${outFile}`);
}

main().catch(err => {
  console.error('[msix] Error:', err);
  process.exit(1);
});
