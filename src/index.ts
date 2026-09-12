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
import type { Context } from '@deepseek-ai/cordis'
import { decideEffort, type EffortId, type ToolCallSample } from './effort-decision.ts'

/** The plugin needs the host `llm` service to verify model capabilities. */
export const inject = ['llm']

/** pi-ai thinking levels in escalation order (mirrors dsh-llm-pi-ai). */
const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Clamp a decided effort to the levels the current model actually accepts.
 * Returns undefined when the model exposes no usable effort level — callers
 * must then leave the request untouched (injecting an unverified effort is
 * rejected by the adapter with UNSUPPORTED_REASONING_EFFORT).
 * Pure; unit-testable without a host.
 */
export function clampEffort(effort: EffortId, supportedIds: readonly unknown[] | undefined): string | undefined {
  if (!Array.isArray(supportedIds)) return undefined
  if (supportedIds.includes(effort)) return effort
  const target = LEVEL_ORDER.indexOf(effort)
  const ranked = supportedIds
    .filter((id): id is string => typeof id === 'string' && (LEVEL_ORDER as readonly string[]).includes(id))
    .sort((a, b) => LEVEL_ORDER.indexOf(a as typeof LEVEL_ORDER[number]) - LEVEL_ORDER.indexOf(b as typeof LEVEL_ORDER[number]))
  if (ranked.length === 0) return undefined
  const below = ranked.filter((id) => LEVEL_ORDER.indexOf(id as typeof LEVEL_ORDER[number]) <= target)
  return below.length > 0 ? below[below.length - 1] : ranked[0]
}

/** Minimal slice of the host llm service this plugin relies on. */
interface LlmLike {
  resolveModelInfo?: (provider: string, model: string) => Promise<{
    reasoning?: { efforts?: { id?: unknown }[] }
  }>
}

/** Supported effort ids of the request's resolved model, or undefined. */
async function supportedEfforts(ctx: Context, seed: unknown): Promise<readonly unknown[] | undefined> {
  const llm = (ctx as unknown as { llm?: LlmLike }).llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
  const provider = (seed as { provider?: unknown })?.provider
  const model = (seed as { model?: unknown })?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const efforts = info?.reasoning?.efforts
    return Array.isArray(efforts) ? efforts.map((e) => e?.id) : undefined
  } catch {
    return undefined
  }
}

/** Plugin settings: active by default, conservative by construction. */
export interface ToolTurboConfig {
  enabled: boolean
  allowDowngrade: boolean
  allowUpgrade: boolean
  /** The user's baseline effort the policy starts from. */
  baseline: EffortId
}

export const DEFAULT_CONFIG: ToolTurboConfig = {
  enabled: true,
  allowDowngrade: true,
  allowUpgrade: false,
  baseline: 'high',
}

const EFFORT_IDS: readonly EffortId[] = ['low', 'high', 'max']

/**
 * Merge a (possibly partial or absent) patch config onto the defaults.
 * A bare default parameter is not enough: the loader passes `undefined`
 * only when the patch entry has no `config` key at all — a partial
 * `config:` would otherwise leave `enabled` undefined and silently
 * disable the plugin.
 */
export function resolveConfig(config: Partial<ToolTurboConfig> | undefined): ToolTurboConfig {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const baseline = (EFFORT_IDS as readonly string[]).includes(merged.baseline)
    ? merged.baseline
    : DEFAULT_CONFIG.baseline
  return { ...merged, baseline }
}

/** Recent tool calls of a session's log, oldest first. */
const TOOL_SAMPLE_WINDOW = 8

interface ToolCallEventData {
  turn?: unknown
  step?: unknown
  callId?: unknown
  name?: unknown
  arguments?: unknown
}

interface SessionLike {
  seq?: unknown
  eventAt?: (seq: number) => { type?: unknown; data?: unknown } | undefined
  id?: unknown
}

function asSession(value: unknown): SessionLike | undefined {
  const session = (value as { session?: unknown }).session as SessionLike | undefined
  if (typeof session?.seq !== 'number' || typeof session?.eventAt !== 'function') return undefined
  return session
}

/**
 * The most recent `tool/call` events of the session log (any step: at
 * request time the current step has no tool calls yet — the decision feeds
 * on the tail of the history that produced the request's context).
 */
function recentToolCalls(agent: unknown): ToolCallSample[] {
  const session = asSession(agent)
  if (session === undefined) return []
  const samples: ToolCallSample[] = []
  for (let index = (session.seq as number) - 1; index >= 0 && samples.length < TOOL_SAMPLE_WINDOW; index -= 1) {
    const event = (session.eventAt as NonNullable<SessionLike['eventAt']>)(index)
    if (event?.type !== 'tool/call') continue
    const data = event.data as ToolCallEventData | undefined
    const name = typeof data?.name === 'string' ? data.name : 'tool'
    const argsSize = typeof data?.arguments === 'string' ? data.arguments.length : 0
    samples.push({ name, argsSize })
  }
  return samples.reverse()
}

/** Upper bound for the best-effort telemetry map: never grow unbounded. */
const MAX_TRACKED_CALLS = 1024

/** Widen the typed `ctx.on` boundary: these dsh events are generated scope
 * events the npm cordis package does not re-export augmentations for. */
type AgentRequestOn = (
  event: 'agent/request',
  handler: (payload: Record<string, unknown>, next: () => unknown) => unknown | Promise<unknown>,
) => void
type SessionEventOn = (
  event: 'session/event',
  handler: (session: SessionLike, event: { type?: unknown; data?: unknown }) => void,
) => void

/**
 * Plugin body.
 * @param ctx - host context carrying the agent-event dispatch.
 * @param config - resolved plugin configuration (partial; merged onto defaults).
 */
export function apply(ctx: Context, config: Partial<ToolTurboConfig> = {}): void {
  const settings = resolveConfig(config)
  if (!settings.enabled) return

  // Inject the effort decision into every model request of a session.
  const onAgentRequest = ctx.on as unknown as AgentRequestOn
  onAgentRequest('agent/request', async (payload, next) => {
    const seed = (await next()) as { reasoningEffort?: unknown } | undefined
    const calls = recentToolCalls(payload?.agent)
    // Fresh prompt (no tool history yet): leave the request untouched so the
    // UI selection or the provider default keeps governing the first round.
    if (calls.length === 0) return seed
    const decided = decideEffort({
      recentCalls: calls,
      selected: settings.baseline,
      allowDowngrade: settings.allowDowngrade,
      allowUpgrade: settings.allowUpgrade,
    })
    const effort = clampEffort(decided, await supportedEfforts(ctx, seed))
    // Model exposes no usable level (or capabilities unknown): leave the
    // request untouched rather than inject an effort the adapter rejects.
    if (effort === undefined) return seed
    ctx.logger?.info?.(
      '[tool-turbo] %d recent tool call(s) -> reasoningEffort=%s (decided=%s baseline=%s)',
      calls.length, effort, decided, settings.baseline,
    )
    return { ...(seed ?? {}), reasoningEffort: effort }
  })

  // Per-tool wall-clock telemetry: time each `tool/call` against its
  // matching `tool/result` on the session event firehose.
  const onSessionEvent = ctx.on as unknown as SessionEventOn
  const startedAt = new Map<string, { name: string; at: number }>()
  onSessionEvent('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event?.type === 'tool/call') {
      const data = event.data as ToolCallEventData | undefined
      const callId = data?.callId
      if (typeof callId !== 'string') return
      if (startedAt.size >= MAX_TRACKED_CALLS) startedAt.clear()
      startedAt.set(`${sessionId}:${callId}`, {
        name: typeof data?.name === 'string' ? data.name : 'tool',
        at: Date.now(),
      })
    } else if (event?.type === 'tool/result') {
      const callId = (event.data as { message?: { source?: { callId?: unknown } } } | undefined)
        ?.message?.source?.callId
      if (typeof callId !== 'string') return
      const started = startedAt.get(`${sessionId}:${callId}`)
      if (started === undefined) return
      startedAt.delete(`${sessionId}:${callId}`)
      ctx.logger?.info?.('[tool-turbo] tool %s took %dms', started.name, Date.now() - started.at)
    }
  })
}
