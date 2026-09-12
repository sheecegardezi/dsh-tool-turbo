/**
 * Pure reasoning-effort decision for the tool-turbo plugin.
 *
 * The measured bottleneck of tool calls in dsh is the model's THINKING phase
 * (~90% of the wall-clock time for simple tasks), not the tool execution
 * itself. DeepSeek's API exposes `reasoning_effort` (low / high / max, plus
 * the adapter-level `off`): dropping a trivial tool round from high to low
 * can cut the think time by 3-5x. The decision below maps the RECENT
 * tool-call history of a session to an effort id.
 *
 * Kept dependency-free (pure inputs -> output) so the policy is unit-testable
 * in isolation; the plugin host feeds it the live session's recent calls.
 */
/** The reasoning-effort steps dsh forwards to DeepSeek. */
export type EffortId = 'low' | 'high' | 'max';
/** One observed tool call of the current/last step. */
export interface ToolCallSample {
    /** Tool name, e.g. 'bash', 'fs_write', 'web_search', 'mcp__...'. */
    name: string;
    /** Approximate argument size in characters (payload heft). */
    argsSize: number;
}
/** Everything the policy needs to decide one request's effort. */
export interface EffortDecisionInput {
    /** Recent tool calls of the session (oldest first); empty for a fresh prompt. */
    recentCalls: readonly ToolCallSample[];
    /** The user-selected baseline effort (what the UI shows). */
    selected: EffortId;
    /** User preference: allow downgrades below the selected baseline. */
    allowDowngrade: boolean;
    /** User preference: allow upgrades above the selected baseline. */
    allowUpgrade: boolean;
}
/**
 * Map a recent tool-call history to the effort dsh should use for the NEXT
 * model request of that session.
 *
 * Rules (pure, testable), evaluated in priority order:
 * 1. No tool calls yet (fresh prompt) -> keep the user's selected effort.
 * 2. Any single very heavy payload -> `max` (one huge argument block makes
 *    the round non-trivial even when the rest of the chain is simple).
 * 3. Mostly simple tools with small payloads -> `low`.
 * 4. Mixed or heavy tools -> `high`.
 *
 * The outcome is then clamped by consent: it never falls BELOW the selected
 * baseline unless `allowDowngrade`, and never rises ABOVE it unless
 * `allowUpgrade`.
 *
 * @param input - recent calls, the selected baseline and the user's toggles.
 * @returns The effort id to inject into the next agent/request.
 */
export declare function decideEffort(input: EffortDecisionInput): EffortId;
/** Wall-clock delta of one tool call, for the timing telemetry. */
export declare function toolDurationMs(startedAt: number, finishedAt: number): number;
