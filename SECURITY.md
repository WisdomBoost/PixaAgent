# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using **[GitHub Security Advisories](https://github.com/WisdomBoost-LLC/PixaAgent/security/advisories/new)**
for this repository. This opens a private discussion visible only to
maintainers until a fix is ready, and lets us credit you properly once it's
disclosed.

If that link doesn't work for you, email **staff.pixaflipai@gmail.com** with
the details instead. Please don't post vulnerability details in a public issue.

### What to include

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept if you have one
- The version/commit you tested against
- Anything you think we'd need to confirm and fix it quickly

### What to expect

- Acknowledgment as soon as we see it — we're a small team, so please be
  patient, but we take reports seriously
- We'll work with you to understand and confirm the issue before any public
  disclosure
- Credit in the fix's release notes, if you'd like it (tell us if you'd
  rather stay anonymous)

## Supported versions

Pixa is pre-1.0 and moving quickly. Only the latest published release is
supported with security fixes — please update before reporting to confirm the
issue still exists on the current version.

## Known security posture — please read before reporting

To avoid duplicate reports of things we already know and have documented:

- **Approved terminal commands are not yet sandboxed.** When you click Approve
  on a command, it runs with your normal user permissions on your machine.
  A destructive-command deny-list blocks known-dangerous patterns before you're
  even asked, but this is a guardrail against careless mistakes, not a hard
  security boundary against a deliberately adversarial model or a malicious
  prompt injection. Full sandboxing is in progress — see open issues.
- **File access is restricted to the open workspace folder** via a path-jail
  (`resolveInWorkspace()`), but this hasn't been adversarially tested against
  symlink or path-traversal tricks. If you find a bypass, that's exactly the
  kind of report we want.
- **API keys are stored in VS Code's `SecretStorage`**, not in `settings.json`
  or in plaintext anywhere Pixa controls. We rely on VS Code's own
  OS-level credential storage (Windows Credential Manager, macOS Keychain,
  Linux Secret Service) for the actual encryption.
- **Cloud model providers receive your code.** If you configure a cloud
  provider (OpenRouter, NVIDIA NIM, etc.), the prompts sent to it include
  relevant file contents. This is expected behavior, not a vulnerability —
  if that's a concern for your use case, use a self-hosted model instead
  (Ollama, vLLM, LM Studio), where nothing leaves your machine.

If your report is about one of the above *as documented*, please still tell
us if you found a way to make it worse than described — that's still useful.

## Scope

This policy covers the `pixa-agent` VS Code extension in this repository.
Vulnerabilities in third-party dependencies should generally be reported
upstream, but let us know too if it affects Pixa directly (e.g., we should
bump a version).
