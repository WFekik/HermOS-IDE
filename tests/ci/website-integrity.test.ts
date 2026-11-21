import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const websiteDir = path.resolve(__dirname, '../../hermos-website');
const indexPath = path.join(websiteDir, 'index.html');

describe('Website Quality, Google SEO Branding & Agentic Research Integrity', () => {
  const html = fs.readFileSync(indexPath, 'utf8');

  it('passes node scripts/version.mjs check in lockstep', () => {
    const output = execSync('node scripts/version.mjs check', {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });
    expect(output).toContain('lockstep at version v1.1.4');
  });

  it('includes all Google Search Favicon & Logo tags in <head>', () => {
    expect(html).toContain('rel="icon" type="image/png" sizes="48x48" href="favicon-48.png"');
    expect(html).toContain('rel="icon" type="image/png" sizes="96x96" href="favicon-96.png"');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="logo.svg"');
    expect(html).toContain('rel="shortcut icon" href="favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png"');
  });

  it('validates JSON-LD structured data includes Organization logo and SoftwareApplication logo', () => {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(jsonLdMatch, 'JSON-LD block must exist').not.toBeNull();

    const parsed = JSON.parse(jsonLdMatch![1]);
    expect(parsed['@graph']).toBeDefined();

    const org = parsed['@graph'].find((item: any) => item['@type'] === 'Organization');
    expect(org, 'Organization schema must exist').toBeDefined();
    expect(org.logo).toBe('https://hermos.is-a.dev/logo.png');
    expect(org.image).toBe('https://hermos.is-a.dev/logo.png');

    const app = parsed['@graph'].find((item: any) => item['@type'] === 'SoftwareApplication');
    expect(app, 'SoftwareApplication schema must exist').toBeDefined();
    expect(app.image).toBe('https://hermos.is-a.dev/logo.png');
    expect(app.logo).toBe('https://hermos.is-a.dev/logo.png');
    expect(app.softwareVersion).toBe('1.1.4');

    const website = parsed['@graph'].find((item: any) => item['@type'] === 'WebSite');
    expect(website, 'WebSite schema must exist').toBeDefined();
  });

  it('contains the Agentic Research section (#research) with all 5 core pillars', () => {
    expect(html).toContain('id="research"');
    expect(html).toMatch(/Autonomous Subagent Swarms/i);
    expect(html).toMatch(/Tree Orchestration/i);
    expect(html).toMatch(/Local Air-Gapped Benchmarking/i);
    expect(html).toMatch(/Research Evals/i);
    expect(html).toMatch(/Model Context Protocol/i);
    expect(html).toMatch(/Deterministic Tool Execution/i);
    expect(html).toMatch(/Headless Browser/i);
    expect(html).toMatch(/DOM Verification/i);
    expect(html).toMatch(/Atomic Git Checkpoints/i);
    expect(html).toMatch(/Rollback Isolation/i);
  });

  it('implements CRO elements: sticky floating download pill and OS auto-detection', () => {
    expect(html).toContain('sticky-download-pill');
    expect(html).toContain('id="sticky-download-btn"');
    expect(html).toContain('id="hero-primary-download-btn"');
    expect(html).toContain('card-win');
    expect(html).toContain('card-mac');
    expect(html).toContain('card-linux');
    expect(html).toContain('terminal-copy-btn');
  });

  it('routes Windows exclusively to Microsoft Store and removes NSIS/MSI downloads', () => {
    expect(html).toContain('https://apps.microsoft.com/detail/9NJXKNSS00WQ');
    expect(html).toContain('Get from Microsoft Store');
    expect(html).not.toMatch(/Download \.exe/i);
    expect(html).not.toMatch(/Download \.msi/i);
  });

  it('decouples repetitive text into clean data structures', () => {
    expect(html).toMatch(/RESEARCH_PILLARS/);
    expect(html).toMatch(/COMPARISON_DATA/);
    expect(html).toMatch(/PROVIDER_DATA/);
    expect(html).toMatch(/FAQ_DATA/);
  });

  it('maintains strict Content Security Policy without forbidden origins', () => {
    const cspMatch = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch![1];
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).not.toContain('unpkg.com');
  });
});
