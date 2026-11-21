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
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  IgnorableNamespaces="uap rescap desktop6">

  <Identity
    Name="${identity.name}"
    Publisher="${identity.publisher}"
    Version="${msixVersion}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${identity.displayName}</DisplayName>
    <PublisherDisplayName>${identity.publisherDisplayName}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <!-- Unvirtualized AppData: the packaged app must read/write the same
         %APPDATA% data directory as legacy NSIS installs so existing users
         migrate without losing their workspace data. Requires the
         unvirtualizedResources restricted capability (Partner Center review). -->
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
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
        BackgroundColor="#050806"
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
    <rescap:Capability Name="unvirtualizedResources" />
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

    // Generate unplated and targetsize taskbar assets so Windows does not add an accent-colored backplate
    const targetSizes = [16, 20, 24, 30, 32, 36, 40, 44, 48, 64, 72, 80, 96, 256];
    for (const size of targetSizes) {
      const resized = await sharp(iconSrc).resize(size, size).toBuffer();
      await fs.promises.writeFile(path.join(targetAssetsDir, `Square44x44Logo.targetsize-${size}.png`), resized);
      await fs.promises.writeFile(path.join(targetAssetsDir, `Square44x44Logo.targetsize-${size}_altform-unplated.png`), resized);
      await fs.promises.writeFile(path.join(targetAssetsDir, `Square44x44Logo.altform-unplated_targetsize-${size}.png`), resized);
    }
  }
}

export function defaultStagingSources() {
  const releaseDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');
  return {
    appExe: path.join(releaseDir, 'app.exe'),
    nodeCandidates: [
      path.join(ROOT_DIR, 'src-tauri', 'node-bin', 'node.exe'),
      path.join(ROOT_DIR, 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe'),
      path.join(releaseDir, 'node.exe'),
    ],
    standalone: path.join(ROOT_DIR, '.next-build', 'standalone'),
  };
}

export function prepareStagingDirectory(stagingDir, sources = defaultStagingSources()) {
  fs.mkdirSync(stagingDir, { recursive: true });

  if (!fs.existsSync(sources.appExe)) {
    throw new Error(`app.exe not found at ${sources.appExe} — run \`npx tauri build --no-bundle\` first.`);
  }
  fs.copyFileSync(sources.appExe, path.join(stagingDir, 'app.exe'));

  const nodeSource = sources.nodeCandidates.find((candidate) => fs.existsSync(candidate));
  if (!nodeSource) {
    throw new Error(
      `node.exe not found (looked in: ${sources.nodeCandidates.join(', ')}) — run scripts/provision-node-sidecar.mjs first.`,
    );
  }
  fs.copyFileSync(nodeSource, path.join(stagingDir, 'node.exe'));

  // An MSIX without the standalone bundle is a silent empty app — fail loudly.
  if (!fs.existsSync(sources.standalone)) {
    throw new Error(`Standalone bundle not found at ${sources.standalone} — run \`npm run build:desktop\` first.`);
  }
  const destUp = path.join(stagingDir, '_up_', '.next-build', 'standalone');
  fs.mkdirSync(path.dirname(destUp), { recursive: true });
  fs.cpSync(sources.standalone, destUp, { recursive: true });

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

  if (fs.existsSync(stagingDir)) {
    // Always re-stage: a leftover staging dir from a previous run would pack
    // stale binaries into the new package.
    console.log(`[msix] Removing stale staging directory...`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  console.log(`[msix] Assembling staging directory...`);
  prepareStagingDirectory(stagingDir);

  await packMsix({ version, stagingDir, outputPath: outFile });
  console.log(`[msix] Successfully packed ${outFile}`);
}

main().catch(err => {
  console.error('[msix] Error:', err);
  process.exit(1);
});
