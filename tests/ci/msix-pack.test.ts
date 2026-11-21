import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  STORE_IDENTITY,
  getMsixVersion,
  generateAppxManifest,
  findMakeAppx,
  stageVisualAssets,
  prepareStagingDirectory,
} from '../../scripts/pack-msix.mjs';

describe('MSIX Packaging & Store Manifest Integrity', () => {
  it('converts semver to 4-part MSIX version format correctly', () => {
    expect(getMsixVersion('1.1.4')).toBe('1.1.4.0');
    expect(getMsixVersion('v1.2.0')).toBe('1.2.0.0');
    expect(getMsixVersion('2.0.0-beta.1')).toBe('2.0.0.0');
    expect(getMsixVersion('')).toBe('1.0.0.0');
  });

  it('matches Partner Center reserved Store Identity exactly', () => {
    expect(STORE_IDENTITY.name).toBe('walidfekik.HermOSIDE');
    expect(STORE_IDENTITY.publisher).toBe('CN=57802A88-72D0-4457-AE13-9703FE1B3C09');
    expect(STORE_IDENTITY.displayName).toBe('HermOS IDE');
    expect(STORE_IDENTITY.executable).toBe('app.exe');
  });

  it('generates a valid, schema-compliant AppxManifest.xml', () => {
    const manifest = generateAppxManifest({ version: '1.1.4' });

    expect(manifest).toContain('Name="walidfekik.HermOSIDE"');
    expect(manifest).toContain('Publisher="CN=57802A88-72D0-4457-AE13-9703FE1B3C09"');
    expect(manifest).toContain('Version="1.1.4.0"');
    expect(manifest).toContain('ProcessorArchitecture="x64"');
    expect(manifest).toContain('<DisplayName>HermOS IDE</DisplayName>');
    expect(manifest).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(manifest).toContain('Executable="app.exe"');
    expect(manifest).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(manifest).toContain('Square150x150Logo="Assets\\Square150x150Logo.png"');
    expect(manifest).toContain('Square44x44Logo="Assets\\Square44x44Logo.png"');
    expect(manifest).toContain('Wide310x150Logo="Assets\\Wide310x150Logo.png"');
    expect(manifest).toContain('Square310x310Logo="Assets\\Square310x310Logo.png"');
  });

  it('opts out of AppData virtualization so Store installs share the NSIS data directory', () => {
    const manifest = generateAppxManifest({ version: '1.1.4' });

    expect(manifest).toContain('xmlns:desktop6=');
    expect(manifest).toContain('<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>');
    expect(manifest).toContain('<rescap:Capability Name="unvirtualizedResources" />');
    // desktop6:FileSystemWriteVirtualization requires Windows 10 2004+.
    expect(manifest).toContain('MinVersion="10.0.19041.0"');
  });

  it('locates MakeAppx.exe or falls back to system PATH', () => {
    const makeAppx = findMakeAppx();
    expect(typeof makeAppx).toBe('string');
    expect(makeAppx.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(makeAppx.toLowerCase()).toContain('makeappx.exe');
    }
  });

  it('stages all required Store visual assets into target directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-test-'));
    try {
      await stageVisualAssets(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'StoreLogo.png'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'Square44x44Logo.png'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'Square150x150Logo.png'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'Square310x310Logo.png'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'Wide310x150Logo.png'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeFakeSources(base: string) {
    const binariesDir = path.join(base, 'binaries');
    const standaloneDir = path.join(base, 'standalone');
    fs.mkdirSync(binariesDir, { recursive: true });
    fs.mkdirSync(standaloneDir, { recursive: true });
    fs.writeFileSync(path.join(base, 'app.exe'), 'exe');
    fs.writeFileSync(path.join(binariesDir, 'node-x86_64-pc-windows-msvc.exe'), 'node');
    fs.writeFileSync(path.join(standaloneDir, 'server.js'), 'x');
    return {
      appExe: path.join(base, 'app.exe'),
      nodeCandidates: [path.join(binariesDir, 'node-x86_64-pc-windows-msvc.exe')],
      standalone: standaloneDir,
    };
  }

  it('stages app.exe, node.exe, and the _up_ standalone bundle', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-src-'));
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-stage-'));
    try {
      const staged = prepareStagingDirectory(stagingDir, makeFakeSources(baseDir));
      expect(staged).toBe(stagingDir);
      expect(fs.existsSync(path.join(stagingDir, 'app.exe'))).toBe(true);
      expect(fs.existsSync(path.join(stagingDir, 'node.exe'))).toBe(true);
      expect(fs.existsSync(path.join(stagingDir, '_up_', '.next-build', 'standalone', 'server.js'))).toBe(true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  it('fails loudly when app.exe, the node sidecar, or the standalone bundle is missing', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-src-'));
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-stage-'));
    try {
      const sources = makeFakeSources(baseDir);
      expect(() => prepareStagingDirectory(stagingDir, { ...sources, appExe: path.join(baseDir, 'missing.exe') }))
        .toThrow(/app\.exe not found/);
      expect(() => prepareStagingDirectory(stagingDir, { ...sources, nodeCandidates: [path.join(baseDir, 'missing-node.exe')] }))
        .toThrow(/node\.exe not found/);
      expect(() => prepareStagingDirectory(stagingDir, { ...sources, standalone: path.join(baseDir, 'missing-standalone') }))
        .toThrow(/Standalone bundle not found/);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});
