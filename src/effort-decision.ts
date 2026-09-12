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
export type EffortId = 'low' | 'high' | 'max'

/** One observed tool call of the current/last step. */
export interface ToolCallSample {
  /** Tool name, e.g. 'bash', 'fs_write', 'web_search', 'mcp__...'. */
  name: string
  /** Approximate argument size in characters (payload heft). */
  argsSize: number
}

/** Everything the policy needs to decide one request's effort. */
export interface EffortDecisionInput {
  /** Recent tool calls of the session (oldest first); empty for a fresh prompt. */
  recentCalls: readonly ToolCallSample[]
  /** The user-selected baseline effort (what the UI shows). */
  selected: EffortId
  /** User preference: allow downgrades below the selected baseline. */
  allowDowngrade: boolean
  /** User preference: allow upgrades above the selected baseline. */
  allowUpgrade: boolean
}

/** Deterministic tool names that are cheap to reason about. */
const SIMPLE_TOOL_RE = /^(fs|bash|terminal|code|text|todo|job|skill|read|list|search|write|grep|glob|edit|ls|cat|rm|mv|cp|touch|mkdir|pwd|head|tail)/i

/** Hefty payloads signal non-trivial work no matter the tool name. */
const HEAVY_ARGS = 800

/** A single very heavy payload outweighs an otherwise-simple ratio. */
const VERY_HEAVY_ARGS = HEAVY_ARGS * 4

/** Ratio of cheap-and-deterministic calls at or above which a chain is "simple". */
const SIMPLE_RATIO = 0.75

/** Effort ranking, used to clamp decisions against the user's baseline. */
const RANK: Record<EffortId, number> = { low: 0, high: 1, max: 2 }

/** Count how many of the recent calls look cheap-and-deterministic. */
function simpleRatio(calls: readonly ToolCallSample[]): number {
  if (calls.length === 0) return 1
  const simple = calls.filter(call =>
    SIMPLE_TOOL_RE.test(call.name) && call.argsSize < HEAVY_ARGS,
  ).length
  return simple / calls.length
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
export function decideEffort(input: EffortDecisionInput): EffortId {
  const { recentCalls, selected, allowDowngrade, allowUpgrade } = input
  if (recentCalls.length === 0) return selected

  const ratio = simpleRatio(recentCalls)
  const heaviest = recentCalls.reduce((max, call) => Math.max(max, call.argsSize), 0)

  let target: EffortId
  if (heaviest >= VERY_HEAVY_ARGS) target = 'max'
  else if (ratio >= SIMPLE_RATIO) target = 'low'
  else target = 'high'

  if (!allowDowngrade && RANK[target] < RANK[selected]) target = selected
  if (!allowUpgrade && RANK[target] > RANK[selected]) target = selected
  return target
}

/** Wall-clock delta of one tool call, for the timing telemetry. */
export function toolDurationMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt)
}
