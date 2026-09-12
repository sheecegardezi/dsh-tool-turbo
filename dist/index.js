import { decideEffort } from "./effort-decision.js";
/** The plugin needs the host `llm` service to verify model capabilities. */
export const inject = ['llm'];
/** pi-ai thinking levels in escalation order (mirrors dsh-llm-pi-ai). */
const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Clamp a decided effort to the levels the current model actually accepts.
 * Returns undefined when the model exposes no usable effort level — callers
 * must then leave the request untouched (injecting an unverified effort is
 * rejected by the adapter with UNSUPPORTED_REASONING_EFFORT).
 * Pure; unit-testable without a host.
 */
export function clampEffort(effort, supportedIds) {
    if (!Array.isArray(supportedIds))
        return undefined;
    if (supportedIds.includes(effort))
        return effort;
    const target = LEVEL_ORDER.indexOf(effort);
    const ranked = supportedIds
        .filter((id) => typeof id === 'string' && LEVEL_ORDER.includes(id))
        .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    if (ranked.length === 0)
        return undefined;
    const below = ranked.filter((id) => LEVEL_ORDER.indexOf(id) <= target);
    return below.length > 0 ? below[below.length - 1] : ranked[0];
}
/** Supported effort ids of the request's resolved model, or undefined. */
async function supportedEfforts(ctx, seed) {
    const llm = ctx.llm;
    if (!llm || typeof llm.resolveModelInfo !== 'function')
        return undefined;
    const provider = seed?.provider;
    const model = seed?.model;
    if (typeof provider !== 'string' || typeof model !== 'string')
        return undefined;
    try {
        const info = await llm.resolveModelInfo(provider, model);
        const efforts = info?.reasoning?.efforts;
        return Array.isArray(efforts) ? efforts.map((e) => e?.id) : undefined;
    }
    catch {
        return undefined;
    }
}
export const DEFAULT_CONFIG = {
    enabled: true,
    allowDowngrade: true,
    allowUpgrade: false,
    baseline: 'high',
};
const EFFORT_IDS = ['low', 'high', 'max'];
/**
 * Merge a (possibly partial or absent) patch config onto the defaults.
 * A bare default parameter is not enough: the loader passes `undefined`
 * only when the patch entry has no `config` key at all — a partial
 * `config:` would otherwise leave `enabled` undefined and silently
 * disable the plugin.
 */
export function resolveConfig(config) {
    const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const baseline = EFFORT_IDS.includes(merged.baseline)
        ? merged.baseline
        : DEFAULT_CONFIG.baseline;
    return { ...merged, baseline };
}
/** Recent tool calls of a session's log, oldest first. */
const TOOL_SAMPLE_WINDOW = 8;
function asSession(value) {
    const session = value.session;
    if (typeof session?.seq !== 'number' || typeof session?.eventAt !== 'function')
        return undefined;
    return session;
}
/**
 * The most recent `tool/call` events of the session log (any step: at
 * request time the current step has no tool calls yet — the decision feeds
 * on the tail of the history that produced the request's context).
 */
function recentToolCalls(agent) {
    const session = asSession(agent);
    if (session === undefined)
        return [];
    const samples = [];
    for (let index = session.seq - 1; index >= 0 && samples.length < TOOL_SAMPLE_WINDOW; index -= 1) {
        const event = session.eventAt(index);
        if (event?.type !== 'tool/call')
            continue;
        const data = event.data;
        const name = typeof data?.name === 'string' ? data.name : 'tool';
        const argsSize = typeof data?.arguments === 'string' ? data.arguments.length : 0;
        samples.push({ name, argsSize });
    }
    return samples.reverse();
}
/** Upper bound for the best-effort telemetry map: never grow unbounded. */
const MAX_TRACKED_CALLS = 1024;
/**
 * Plugin body.
 * @param ctx - host context carrying the agent-event dispatch.
 * @param config - resolved plugin configuration (partial; merged onto defaults).
 */
export function apply(ctx, config = {}) {
    const settings = resolveConfig(config);
    if (!settings.enabled)
        return;
    // Inject the effort decision into every model request of a session.
    const onAgentRequest = ctx.on;
    onAgentRequest('agent/request', async (payload, next) => {
        const seed = (await next());
        const calls = recentToolCalls(payload?.agent);
        // Fresh prompt (no tool history yet): leave the request untouched so the
        // UI selection or the provider default keeps governing the first round.
        if (calls.length === 0)
            return seed;
        const decided = decideEffort({
            recentCalls: calls,
            selected: settings.baseline,
            allowDowngrade: settings.allowDowngrade,
            allowUpgrade: settings.allowUpgrade,
        });
        const effort = clampEffort(decided, await supportedEfforts(ctx, seed));
        // Model exposes no usable level (or capabilities unknown): leave the
        // request untouched rather than inject an effort the adapter rejects.
        if (effort === undefined)
            return seed;
        ctx.logger?.info?.('[tool-turbo] %d recent tool call(s) -> reasoningEffort=%s (decided=%s baseline=%s)', calls.length, effort, decided, settings.baseline);
        return { ...(seed ?? {}), reasoningEffort: effort };
    });
    // Per-tool wall-clock telemetry: time each `tool/call` against its
    // matching `tool/result` on the session event firehose.
    const onSessionEvent = ctx.on;
    const startedAt = new Map();
    onSessionEvent('session/event', (session, event) => {
        const sessionId = session?.id;
        if (typeof sessionId !== 'string')
            return;
        if (event?.type === 'tool/call') {
            const data = event.data;
            const callId = data?.callId;
            if (typeof callId !== 'string')
                return;
            if (startedAt.size >= MAX_TRACKED_CALLS)
                startedAt.clear();
            startedAt.set(`${sessionId}:${callId}`, {
                name: typeof data?.name === 'string' ? data.name : 'tool',
                at: Date.now(),
            });
        }
        else if (event?.type === 'tool/result') {
            const callId = event.data
                ?.message?.source?.callId;
            if (typeof callId !== 'string')
                return;
            const started = startedAt.get(`${sessionId}:${callId}`);
            if (started === undefined)
                return;
            startedAt.delete(`${sessionId}:${callId}`);
            ctx.logger?.info?.('[tool-turbo] tool %s took %dms', started.name, Date.now() - started.at);
        }
    });
}
