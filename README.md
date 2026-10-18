# opencode-model-relay

> Status: design phase. Not installable yet.

An [OpenCode](https://opencode.ai) plugin that keeps a session alive when the current model fails or underperforms: it detects the failure, optionally asks a cheap judge model whether to switch, has a capable model write a structured handover, and resumes the work on the next model in your tier list. It also keeps 30 days of per-model performance data.

Design: [docs/superpowers/specs/2026-10-18-model-relay-design.md](docs/superpowers/specs/2026-10-18-model-relay-design.md)

Bring your own OpenRouter key. Nothing is sent to any third party unless you opt in.
