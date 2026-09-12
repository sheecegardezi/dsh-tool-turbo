/**
 * dsh-tool-turbo host plugin: lowers tool-call latency by injecting a
 * task-appropriate `reasoning_effort` into every `agent/request` waterfall,
 * and records per-tool wall-clock durations for telemetry.
 *
 * Extension points used (verified against @deepseek-ai/dsh-agent 0.1.2-rc.1):
 * - `agent/request` waterfall: payload `{ agent, turn, step, signal }`; each
 *   listener may return a modified `LlmCallConfig` for the next listener —
 *   the sanctioned way to adjust request config. `reasoningEffort` is an
 *   `LlmCallConfig` field the DeepSeek adapter forwards as the wire
 *   `reasoning_effort`.
 * - `session/event` firehose: `(session, event)` for every appended event;
 *   `tool/call` data is `{ turn, step, callId, name, arguments }` and
 *   `tool/result` data carries `message.source.callId`. This is the live
 *   source for both the effort history and the duration telemetry.
 * - `Session.eventAt(seq)` / `Session.seq`: O(1) reads into the durable log
 *   for the recent-call window (no per-request snapshot copies).
 */
import type { Context } from '@deepseek-ai/cordis';
import { type EffortId } from './effort-decision.ts';
/** Plugin settings: active by default, conservative by construction. */
export interface ToolTurboConfig {
    enabled: boolean;
    allowDowngrade: boolean;
    allowUpgrade: boolean;
    /** The user's baseline effort the policy starts from. */
    baseline: EffortId;
}
export declare const DEFAULT_CONFIG: ToolTurboConfig;
/**
 * Merge a (possibly partial or absent) patch config onto the defaults.
 * A bare default parameter is not enough: the loader passes `undefined`
 * only when the patch entry has no `config` key at all — a partial
 * `config:` would otherwise leave `enabled` undefined and silently
 * disable the plugin.
 */
export declare function resolveConfig(config: Partial<ToolTurboConfig> | undefined): ToolTurboConfig;
/**
 * Plugin body.
 * @param ctx - host context carrying the agent-event dispatch.
 * @param config - resolved plugin configuration (partial; merged onto defaults).
 */
export declare function apply(ctx: Context, config?: Partial<ToolTurboConfig>): void;
