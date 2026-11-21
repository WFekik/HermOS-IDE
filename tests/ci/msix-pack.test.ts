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

  it('prepares staging directory structure gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermos-msix-stage-'));
    try {
      const staged = prepareStagingDirectory(tmpDir);
      expect(staged).toBe(tmpDir);
      expect(fs.existsSync(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
