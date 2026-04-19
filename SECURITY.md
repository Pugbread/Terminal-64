# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report vulnerabilities privately via GitHub's private vulnerability reporting:

👉 **https://github.com/Pugbread/Terminal-64/security/advisories/new**

When reporting, please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept welcome)
- The affected version(s) or commit SHA
- Any suggested mitigations, if known

You should receive an initial acknowledgement within **7 days**. We'll work with you on a fix and coordinate disclosure once a patch is ready.

## Scope

Terminal 64 is a desktop app that bundles a number of powerful surfaces — PTYs, the Claude CLI, an optional Discord bot, an MCP permission server, a localhost widget HTTP server, native browser webviews, and system audio capture. Issues that are particularly valuable to report:

- Path traversal or arbitrary file read/write via widget/skill paths, session history, or IPC commands
- Command injection in PTY spawn, Claude CLI arguments, or shell bridge APIs
- Sandbox escapes from the widget iframe (`t64:*` postMessage bridge)
- Authentication or authorization flaws in the permission server or Discord bot
- Mishandling of secrets (API keys, session tokens) in logs, storage, or IPC payloads
- RCE, privilege escalation, or cross-site scripting surfaces in rendered content

## Out of scope

- Vulnerabilities in upstream dependencies without a demonstrated exploit path in Terminal 64 (please report those upstream)
- Issues requiring a pre-compromised machine or physical access
- Social-engineering or phishing reports

## Supported versions

Only the latest `master` branch is actively supported. Fixes will ship in the next release.
