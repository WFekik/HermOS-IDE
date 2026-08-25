# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅        |

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories (preferred) or by opening a draft advisory at https://github.com/WFekik/HermOS-IDE/security/advisories/new. Do not open a public issue for sensitive reports. We aim to acknowledge within 48 hours and ship a fix within 7 days for critical issues.

## Threat Model

HermOS IDE is a **local-first desktop app**. The Next.js server binds only to `127.0.0.1` (loopback) and rejects non-loopback `Host`/`Origin` headers on every mutating route. Provider API keys are stored AES-256-GCM encrypted with a per-install key at `~/.hermos/.secret_key` (0600 on Unix). There are no HermOS servers, no telemetry, and no cloud auth.

Out-of-scope for the default local deployment: an attacker who already has arbitrary code execution on the same OS account can read the local database and key file — this is the same privilege as the app itself.

## Known Limitations

- Outbound requests (agent HTTP tools, Built-in Browser proxy, plugin endpoints) are guarded against SSRF and DNS-rebinding TOCTOU via an undici dispatcher with custom DNS lookup verification, validating resolved IP addresses against private/link-local policies before connection while preserving SNI, Host headers, and TLS certificate validation.
- Desktop shell port selection probes loopback ports 3001–3999; a local process squatting the chosen port at startup is mitigated by an instance-token handshake (`HERMOS_INSTANCE_TOKEN` echoed as `X-HermOS-Instance-Token` on `/api/health`) before the webview navigates. `remote.urls` in `src-tauri/capabilities/default.json` is scoped to `http://127.0.0.1:*` only.
- `HERMOS_ENABLE_COMMANDS` is opt-out (default enabled) — set `HERMOS_ENABLE_COMMANDS=false` to disable terminal/command execution.
