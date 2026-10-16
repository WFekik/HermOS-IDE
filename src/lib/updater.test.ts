// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import {
  checkForUpdates,
  recordPendingUpdate,
  readPendingUpdate,
  clearPendingUpdate,
  consumeStaleUpdate,
  releaseTagUrl,
  isFileLockError,
  installWithRetries,
  InstallBlockedError,
} from './updater';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

    it('consumeStaleUpdate: returns null when no update was pending', () => {
      expect(consumeStaleUpdate()).toBeNull();
    });

    it('consumeStaleUpdate: clears pending and returns null when update applied successfully', () => {
      // Current app version is 1.1.2
      recordPendingUpdate('1.1.1', '1.1.2');
      expect(readPendingUpdate()).not.toBeNull();
      expect(consumeStaleUpdate()).toBeNull();
      expect(readPendingUpdate()).toBeNull();
    });

    it('consumeStaleUpdate: normalizes "v" prefix in version comparison', () => {
      recordPendingUpdate('v1.1.1', 'v1.1.2');
      expect(consumeStaleUpdate()).toBeNull();
      expect(readPendingUpdate()).toBeNull();
    });

    it('consumeStaleUpdate: clears pending and returns null when current is already newer', () => {
      // Current is 1.1.2, pending target was 1.1.0
      localStorage.setItem(
        'hermos:pending-update',
        JSON.stringify({ from: '1.0.9', to: '1.1.0', at: Date.now() }),
      );
      expect(consumeStaleUpdate()).toBeNull();
      expect(readPendingUpdate()).toBeNull();
    });

    it('consumeStaleUpdate: returns pending when current is still on "from" version (install did not apply)', () => {
      // Current is 1.1.2, update was attempted to 1.1.3
      recordPendingUpdate('1.1.2', '1.1.3');
      const stale = consumeStaleUpdate();
      expect(stale).toMatchObject({ from: '1.1.2', to: '1.1.3' });
    });

    it('consumeStaleUpdate: drops stale record when on unknown / rollback version', () => {
      // Current is 1.1.2, pending was between two completely different historical versions
      localStorage.setItem(
        'hermos:pending-update',
        JSON.stringify({ from: '0.9.0', to: '0.9.5', at: Date.now() }),
      );
      expect(consumeStaleUpdate()).toBeNull();
      expect(readPendingUpdate()).toBeNull();
    });
  });

  describe('isFileLockError', () => {
    it.each([
      ['cannot remove _up directory: file in use', true],
      ['cannot remove _up_ staging dir', true],
      // Bare "my_uploads" must NOT match the NSIS _up staging token.
      ['failed to clean my_uploads cache', false],
      ['EBUSY: resource busy or locked', true],
      ['EPERM: operation not permitted', true],
      ['The process cannot access the file because it is being used by another process', true],
      ['Access is denied (os error 5)', true],
      ['failed to remove directory: Access is denied', true],
      ['Network offline', false],
      ['signature verification failed', false],
      // "blocked"/"clock"/"unlock" contain "lock" as a substring but are
      // not file locks (leading \b fails: preceding char is a word char).
      ['request blocked by policy', false],
      ['wall clock skew detected', false],
      ['please unlock the file', false],
      // Real Windows lock phrasing — MUST retry (isolated from ebusy/eperm
      // branches so the regex itself is exercised, not a sibling clause).
      ['the file is locked', true],
      ['installer locks file', true],
      ['locking the directory failed', true],
      // bare "remove" without "directory" must not match.
      ['failed to remove temp file', false],
      // NSIS "Error opening file for writing" — the dialog shown when the
      // sidecar (node.exe) or a loaded native module is alive at install
      // time. Must retry/retain-pending, never drop as definitive.
      ['Error opening file for writing: C:\\Users\\ADMINI~1\\AppData\\Local\\HermOS IDE\\node.exe', true],
      ['Error opening file for writing: C:\\PROGRA~1\\HermOS IDE\\resources\\.next-build\\standalone\\node_modules\\prisma\\client\\query_engine-windows.dll.node', true],
      // "file for reading" is NOT a write lock — must not match.
      ['failed to open the release-notes file for reading', false],
      // Bare write failures (disk full etc.) are definitive, not locks —
      // they must fail fast and clear pending, never retry or re-nag.
      ['failed to write file to disk: no space left on device', false],
    ])('classifies %q as lock=%s', (message, expected) => {
      expect(isFileLockError(new Error(message))).toBe(expected);
    });
  });

  describe('installWithRetries', () => {
    it('succeeds first try without re-stopping', async () => {
      const install = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const attempts: number[] = [];
      await installWithRetries(install, (n) => attempts.push(n), stop);
      expect(install).toHaveBeenCalledTimes(1);
      expect(attempts).toEqual([1]);
      expect(stop).not.toHaveBeenCalled();
    });

    it('retries lock errors with backoff then succeeds', async () => {
      const install = vi
        .fn()
        .mockRejectedValueOnce(new Error('EBUSY: _up file in use'))
        .mockRejectedValueOnce(new Error('EPERM lock'))
        .mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const attempts: number[] = [];
      await installWithRetries(install, (n) => attempts.push(n), stop);
      expect(install).toHaveBeenCalledTimes(3);
      expect(attempts).toEqual([1, 2, 3]);
      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on non-lock errors', async () => {
      const install = vi.fn().mockRejectedValue(new Error('signature verification failed'));
      const stop = vi.fn().mockResolvedValue(undefined);
      await expect(
        installWithRetries(install, () => {}, stop),
      ).rejects.toThrow('signature verification failed');
      expect(install).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    });

    it('throws after exhausting attempts on persistent locks', async () => {
      const install = vi.fn().mockRejectedValue(new Error('file is being used by another process'));
      const stop = vi.fn().mockResolvedValue(undefined);
      const attempts: number[] = [];
      await expect(
        installWithRetries(install, (n) => attempts.push(n), stop),
      ).rejects.toThrow('being used');
      expect(install).toHaveBeenCalledTimes(4);
      expect(attempts).toEqual([1, 2, 3, 4]);
      expect(stop).toHaveBeenCalledTimes(3);
    });
  });

  describe('quiet titlebar-button mode (desktop)', () => {
    const mockCheck = vi.mocked(check);
    const mockRelaunch = vi.mocked(relaunch);
    const mockInvoke = vi.mocked(invoke);

    function makeUpdate(overrides: Record<string, unknown> = {}) {
      return {
        version: '9.9.9',
        body: 'notes',
        download: vi.fn(async (cb: (e: { event: string; data?: Record<string, number> }) => void) => {
          cb({ event: 'Started', data: { contentLength: 1000 } });
          cb({ event: 'Progress', data: { chunkLength: 1000 } });
          cb({ event: 'Finished' });
        }),
        install: vi.fn(async () => {}),
        ...overrides,
      };
    }

    beforeEach(() => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      localStorage.clear();
      mockRelaunch.mockResolvedValue(undefined as unknown as void);
      mockInvoke.mockResolvedValue(true);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      );
      vi.spyOn(toast, 'loading').mockImplementation(() => 'x' as unknown as string & { id: string });
      vi.spyOn(toast, 'error').mockImplementation(() => 'x' as unknown as string & { id: string });
      vi.spyOn(toast, 'dismiss').mockImplementation(() => {});
    });

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      localStorage.clear();
      vi.unstubAllGlobals();
    });

    it('quiet success: callbacks fire, toasts suppressed, pending recorded', async () => {
      mockCheck.mockResolvedValue(makeUpdate() as unknown as Awaited<ReturnType<typeof check>>);
      const stages: string[] = [];
      const progress: Array<[number, number]> = [];
      const result = await checkForUpdates(true, {
        quiet: true,
        onProgress: (d, t) => progress.push([d, t]),
        onStage: (s) => stages.push(s),
      });
      expect(result).toMatchObject({ status: 'downloaded', version: '9.9.9' });
      expect(stages).toEqual(['downloading', 'installing']);
      expect(progress).toEqual([[0, 1000], [1000, 1000]]);
      expect(toast.loading).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.dismiss).not.toHaveBeenCalled();
      const pending = readPendingUpdate();
      expect(pending).toMatchObject({ to: '9.9.9' });
    });

    it('quiet definitive failure: throws, no error toast, pending cleared', async () => {
      mockCheck.mockResolvedValue(
        makeUpdate({ install: vi.fn().mockRejectedValue(new Error('signature verification failed')) }) as unknown as Awaited<ReturnType<typeof check>>,
      );
      await expect(checkForUpdates(true, { quiet: true })).rejects.toThrow(
        'signature verification failed',
      );
      expect(toast.error).not.toHaveBeenCalled();
      expect(readPendingUpdate()).toBeNull();
    });

    it('non-quiet success still shows progress toasts (legacy path)', async () => {
      mockCheck.mockResolvedValue(makeUpdate() as unknown as Awaited<ReturnType<typeof check>>);
      const result = await checkForUpdates(true);
      expect(result.status).toBe('downloaded');
      expect(toast.loading).toHaveBeenCalled();
    });

    it('blocked by surviving locks: aborts before install, clears pending, no second toast', async () => {
      const upd = makeUpdate();
      mockCheck.mockResolvedValue(upd as unknown as Awaited<ReturnType<typeof check>>);
      // stop_node_sidecar resolves truthy (boolean); the lock probe reports
      // node.exe still locked. Non-array probe payloads (like this boolean)
      // must mean "unknown → proceed", so route by command name.
      mockInvoke.mockImplementation(((cmd: string) =>
        Promise.resolve(
          cmd === 'check_install_locks' ? ['C:\\HermOS IDE\\node.exe'] : true,
        )) as unknown as typeof invoke);
      await expect(checkForUpdates(true)).rejects.toThrow(InstallBlockedError);
      expect(upd.install).not.toHaveBeenCalled();
      expect(readPendingUpdate()).toBeNull();
      expect(toast.error).toHaveBeenCalled();
      // Persistent lock: probe retried to ride out transient holders.
      expect(
        mockInvoke.mock.calls.filter((args) => args[0] === 'check_install_locks'),
      ).toHaveLength(3);
    });

    it('transient lock clears on re-probe: install proceeds', async () => {
      const upd = makeUpdate();
      mockCheck.mockResolvedValue(upd as unknown as Awaited<ReturnType<typeof check>>);
      let probeCalls = 0;
      mockInvoke.mockImplementation(((cmd: string) => {
        if (cmd === 'check_install_locks') {
          probeCalls += 1;
          return Promise.resolve(probeCalls === 1 ? ['C:\\HermOS IDE\\node.exe'] : []);
        }
        return Promise.resolve(true);
      }) as unknown as typeof invoke);
      const result = await checkForUpdates(true, { quiet: true });
      expect(result).toMatchObject({ status: 'downloaded', version: '9.9.9' });
      expect(upd.install).toHaveBeenCalledTimes(1);
      expect(probeCalls).toBe(2);
    });

    it('quiet blocked: throws InstallBlockedError, no error toast, pending cleared', async () => {
      const upd = makeUpdate();
      mockCheck.mockResolvedValue(upd as unknown as Awaited<ReturnType<typeof check>>);
      mockInvoke.mockImplementation(((cmd: string) =>
        Promise.resolve(
          cmd === 'check_install_locks'
            ? ['C:\\HermOS IDE\\node.exe', 'C:\\HermOS IDE\\query_engine-windows.dll.node']
            : true,
        )) as unknown as typeof invoke);
      await expect(checkForUpdates(true, { quiet: true })).rejects.toThrow(
        InstallBlockedError,
      );
      expect(upd.install).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(readPendingUpdate()).toBeNull();
    });

    it('unknown probe payload proceeds to install (backward compatible)', async () => {
      mockCheck.mockResolvedValue(makeUpdate() as unknown as Awaited<ReturnType<typeof check>>);
      mockInvoke.mockResolvedValue(true);
      const result = await checkForUpdates(true, { quiet: true });
      expect(result).toMatchObject({ status: 'downloaded', version: '9.9.9' });
    });
  });
});
