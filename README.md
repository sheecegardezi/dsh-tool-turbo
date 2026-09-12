# dsh-tool-turbo

**Cut tool-call latency in [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) by auto-adjusting `reasoning_effort` per tool round.**

[中文文档](./README.zh.md) · English

In a multi-step tool chain, the model re-thinks before **every** tool call — and that thinking dominates the wall-clock time (a 50-step agent task can spend minutes in reasoning between tools). `dsh-tool-turbo` watches the recent tool calls of a step and injects the *lowest sensible* reasoning effort into the next model request, then lifts it again the moment the work gets heavy.

## How it works

DeepSeek's API exposes `reasoning_effort` in three steps (`low` / `high` / `max`, shipped 2026-08-13). dsh re-resolves the request config for **every step** through an `agent/request` waterfall (see `packages/core/agent-loop/src/agent.ts` — "plugins propose the next request config"). `dsh-tool-turbo` plugs into that waterfall:

1. **Watch** the step's recent `tool/call` records from the session.
2. **Decide**: simple, deterministic tools (`write`, `read`, `grep`, `glob`, `bash`, `fs_*`, …) with small payloads → `low`; mixed/heavy work → `high`; very heavy payloads → `max` (opt-in).
3. **Inject** the decision into the `agent/request` config for the next model call of that step.

Long tool chains keep the cheap rounds cheap, and never starve the hard rounds of reasoning.

## Install

```bash
# 1. clone + install dev dependencies (typecheck/tests only)
git clone https://github.com/Electricitysheep/dsh-tool-turbo.git
cd dsh-tool-turbo && npm install

# 2. register into a dsh profile (web shown; any profile works)
#    from a packed tarball:
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-tool-turbo-0.1.1.tgz
#    or directly from the checkout:
dsh plugin --profile web add /absolute/path/to/dsh-tool-turbo

# 3. restart dsh web — bundle layers load at boot
dsh web
```

Toggles are patch-entry config keys (`enabled`, `allowDowngrade`, `allowUpgrade`, `baseline`); unspecified keys fall back to the defaults, so a partial `config:` block is safe.

## Runtime API notes

Verified against `@deepseek-ai/dsh-agent` / `dsh-session` `0.1.2-rc.1`:

- `agent/request` is a waterfall: payload `{ agent, turn, step, signal }`, `next()` resolves the `LlmCallConfig`; returning a modified copy is the sanctioned way to adjust request config (`reasoningEffort` is forwarded as the wire `reasoning_effort`).
- Session history is read through `Session.eventAt(seq)` + `Session.seq` — the `Session` class exposes **no** `.events` property.
- Per-tool durations come from the `session/event` firehose (`tool/call` → `tool/result`, correlated by `callId` per session id). There is no `agent/tool` event.

## Verified

- **17 unit tests** across the effort policy (`decideEffort`) and the host wiring (`apply`): fresh prompts keep the effective request untouched, simple-tool chains downgrade to `low`, downgrades/upgrades respect the user toggles in both directions (never below baseline without `allowDowngrade`), one very heavy payload wins over an otherwise-simple ratio, and telemetry times `tool/call` → `tool/result`.
- `tsc --noEmit` clean.

## Policy (pure, testable)

| Recent tool calls | Decision |
|---|---|
| none (fresh prompt) | leave the request untouched |
| any single very heavy payload (≥ 3200 chars) | `max` |
| ≥75% simple tools, small args, downgrade allowed | `low` |
| mixed / heavy tools | `high` (when upgrades allowed) |
| otherwise / consent clamps | keep user's selected effort |

Toggles (settings namespace planned): `allowDowngrade` (default on), `allowUpgrade` (default off — keep `max` conservative), `baseline` (default `high`).

## Roadmap

- [x] effort-decision core + waterfall injection
- [x] per-tool duration telemetry (host log)
- [ ] settings namespace (dsh-settings) for the toggles
- [ ] tool timing surfaced in the UI / agent context
- [ ] profile-agnostic install docs (`headless`/`tui`)

## License

MIT
