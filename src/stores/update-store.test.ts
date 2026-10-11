// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore, shouldShowUpdateButton } from './update-store';

const info = {
  currentVersion: '1.0.9',
  latestVersion: '1.1.0',
  releaseName: 'v1.1.0',
  releaseNotes: 'notes',
  releaseUrl: 'https://example.com/r',
};

describe('update-store (persistent titlebar update state)', () => {
  beforeEach(() => {
    useUpdateStore.getState().reset();
  });

  it('starts hidden', () => {
    const s = useUpdateStore.getState();
    expect(s.status).toBe('idle');
    expect(shouldShowUpdateButton(s)).toBe(false);
  });

  it('shows the button once an update is available (never auto-dismisses)', () => {
    useUpdateStore.getState().markAvailable(info);
    const s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.latestVersion).toBe('1.1.0');
    expect(shouldShowUpdateButton(s)).toBe(true);
  });

  it('tracks download progress without hiding', () => {
    useUpdateStore.getState().markAvailable(info);
    useUpdateStore.getState().markDownloading(512, 1024);
    const s = useUpdateStore.getState();
    expect(s.status).toBe('downloading');
    expect(s.downloadedBytes).toBe(512);
    expect(s.totalBytes).toBe(1024);
    expect(shouldShowUpdateButton(s)).toBe(true);
  });

  it('moves through installing to ready-restart', () => {
    useUpdateStore.getState().markAvailable(info);
    useUpdateStore.getState().markInstalling();
    expect(useUpdateStore.getState().status).toBe('installing');
    useUpdateStore.getState().markReadyRestart();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('ready-restart');
    expect(shouldShowUpdateButton(s)).toBe(true);
  });

  it('keeps failure visible with the error (user retries explicitly)', () => {
    useUpdateStore.getState().markAvailable(info);
    useUpdateStore.getState().markFailed('EBUSY');
    const s = useUpdateStore.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toBe('EBUSY');
    expect(shouldShowUpdateButton(s)).toBe(true);
  });

  it('dismiss ("Not now") hides only the dismissed version', () => {
    useUpdateStore.getState().markAvailable(info);
    useUpdateStore.getState().dismiss();
    let s = useUpdateStore.getState();
    expect(s.status).toBe('idle');
    expect(shouldShowUpdateButton(s)).toBe(false);
    // Same version re-reported (e.g. next periodic check) stays hidden…
    useUpdateStore.getState().markAvailable(info);
    s = useUpdateStore.getState();
    expect(shouldShowUpdateButton(s)).toBe(false);
    // …but a NEWER version re-appears and clears the dismissal.
    useUpdateStore.getState().markAvailable({ ...info, latestVersion: '1.2.0' });
    s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.dismissedVersion).toBeNull();
    expect(shouldShowUpdateButton(s)).toBe(true);
  });
});
