// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkForUpdates,
  recordPendingUpdate,
  readPendingUpdate,
  clearPendingUpdate,
  releaseTagUrl,
} from './updater';

describe('updater', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('web / dev mode update check', () => {
    it('returns up-to-date when remote has same or no update', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.0.2', update: { hasUpdate: false, latestVersion: '1.0.2' } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await checkForUpdates(false);
      expect(result.status).toBe('up-to-date');

      vi.unstubAllGlobals();
    });

    it('returns available with details when remote has newer version', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '1.0.2',
          update: {
            hasUpdate: true,
            latestVersion: '1.0.3',
            releaseUrl: 'https://github.com/WFekik/HermOS-IDE/releases/tag/v1.0.3',
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await checkForUpdates(false);
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.latestVersion).toBe('1.0.3');
        expect(result.releaseUrl).toContain('v1.0.3');
      }

      vi.unstubAllGlobals();
    });

    it('handles fetch errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network offline'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await checkForUpdates(false);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.message).toContain('Network offline');
      }

      vi.unstubAllGlobals();
    });
  });

  describe('pending-update record (verify-on-launch)', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('builds a tag URL with normalized version', () => {
      expect(releaseTagUrl('1.0.7')).toBe(
        'https://github.com/WFekik/HermOS-IDE/releases/tag/v1.0.7',
      );
      expect(releaseTagUrl('v1.0.7')).toBe(
        'https://github.com/WFekik/HermOS-IDE/releases/tag/v1.0.7',
      );
    });

    it('round-trips a pending record and clears it', () => {
      expect(readPendingUpdate()).toBeNull();
      recordPendingUpdate('1.0.6', '1.0.7');
      const pending = readPendingUpdate();
      expect(pending).toMatchObject({ from: '1.0.6', to: '1.0.7' });
      expect(typeof pending?.at).toBe('number');
      clearPendingUpdate();
      expect(readPendingUpdate()).toBeNull();
    });

    it('rejects same-version and corrupted records', () => {
      recordPendingUpdate('1.0.7', '1.0.7');
      expect(readPendingUpdate()).toBeNull();
      localStorage.setItem('hermos:pending-update', 'not-json{{{');
      expect(readPendingUpdate()).toBeNull();
    });
  });
});
