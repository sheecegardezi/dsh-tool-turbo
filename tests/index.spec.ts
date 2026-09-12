import { describe, expect, it, vi } from 'vitest'
import { apply, resolveConfig, DEFAULT_CONFIG, clampEffort } from '../src/index.ts'

type Handler = (...args: unknown[]) => unknown
interface Harness {
  ctx: {
    on: (event: string, handler: Handler) => void
    logger: { info: ReturnType<typeof vi.fn> }
    llm?: { resolveModelInfo: (provider: string, model: string) => Promise<unknown> }
  }
  handlers: Map<string, Handler>
}

/** Default mock model admits the plugin's whole low/high/max universe. */
function makeCtx(supported: readonly string[] | null = ['low', 'high', 'max']): Harness {
  const handlers = new Map<string, Handler>()
  const ctx: Harness['ctx'] = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler) },
    logger: { info: vi.fn() },
  }
  if (supported !== null) {
    ctx.llm = {
      resolveModelInfo: async () => ({ reasoning: { efforts: supported.map((id) => ({ id })) } }),
    }
  }
  return { ctx, handlers }
}

/** Minimal Session stand-in: `seq` + O(1) `eventAt` over an event array. */
function makeAgent(events: unknown[]) {
  return {
    session: {
      id: 'session-1',
      seq: events.length,
      eventAt: (seq: number) => events[seq],
    },
  }
}

describe('apply (host wiring)', () => {
  it('leaves a fresh prompt untouched (no tool history yet)', async () => {
    const { ctx, handlers } = makeCtx()
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const seed = { provider: 'deepseek', model: 'deepseek-chat' }
    const result = await request({ agent: makeAgent([]) }, async () => seed)
    expect(result).toBe(seed)
    expect(ctx.logger.info).not.toHaveBeenCalled()
  })

  it('injects the decided effort once the session has tool history', async () => {
    const { ctx, handlers } = makeCtx()
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const agent = makeAgent([
      { type: 'user/message', data: {} },
      { type: 'tool/call', data: { name: 'bash', arguments: 'ls', callId: 'c1' } },
    ])
    const result = await request({ agent }, async () => ({ provider: 'deepseek', model: 'deepseek-chat' })) as Record<string, unknown>
    expect(result['reasoningEffort']).toBe('low')
    expect(result['model']).toBe('deepseek-chat')
    expect(ctx.logger.info).toHaveBeenCalled()
  })

  it('reads tool calls through Session.eventAt, not a snapshot property', async () => {
    const { ctx, handlers } = makeCtx()
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const agent = makeAgent([
      { type: 'tool/call', data: { name: 'mcp__docs', arguments: 'x'.repeat(4000), callId: 'c1' } },
    ])
    // 4000-char payload: even with upgrades off the effort must not drop to low.
    const result = await request({ agent }, async () => ({ provider: 'deepseek', model: 'deepseek-chat' })) as Record<string, unknown>
    expect(result['reasoningEffort']).toBe('high')
  })

  it('times tool/call -> tool/result on the session/event firehose', () => {
    vi.useFakeTimers()
    try {
      const { ctx, handlers } = makeCtx()
      apply(ctx as never)
      const fire = handlers.get('session/event')!
      const session = { id: 'session-1' }
      fire(session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: 'ls' } })
      vi.advanceTimersByTime(1500)
      fire(session, {
        type: 'tool/result',
        data: { message: { source: { kind: 'tool', callId: 'c1' } } },
      })
      expect(ctx.logger.info).toHaveBeenCalledWith('[tool-turbo] tool %s took %dms', 'bash', 1500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores tool/result without a matching tool/call', () => {
    const { ctx, handlers } = makeCtx()
    apply(ctx as never)
    handlers.get('session/event')!({ id: 's' }, {
      type: 'tool/result',
      data: { message: { source: { kind: 'tool', callId: 'nope' } } },
    })
    expect(ctx.logger.info).not.toHaveBeenCalled()
  })
})

describe('clampEffort', () => {
  it('keeps an effort the model supports', () => {
    expect(clampEffort('low', ['low', 'medium', 'xhigh'])).toBe('low')
  })

  it('snaps down to the nearest supported level (qwen3.8-max: low/medium/xhigh)', () => {
    expect(clampEffort('high', ['low', 'medium', 'xhigh'])).toBe('medium')
    expect(clampEffort('max', ['low', 'medium', 'xhigh'])).toBe('xhigh')
  })

  it('snaps up to the lowest supported level when nothing is below (deepseek-v4: high/max)', () => {
    expect(clampEffort('low', ['high', 'max'])).toBe('high')
  })

  it('refuses when the model exposes no usable level or capabilities are unknown', () => {
    expect(clampEffort('high', [])).toBeUndefined()
    expect(clampEffort('high', undefined)).toBeUndefined()
    expect(clampEffort('high', ['bogus'])).toBeUndefined()
  })
})

describe('apply (model capability clamp)', () => {
  const toolHistory = () => makeAgent([
    { type: 'tool/call', data: { name: 'bash', arguments: 'ls', callId: 'c1' } },
  ])
  const seed = { provider: 'qwen-token-plan', model: 'qwen3.8-max' }

  it('keeps a simple-chain low when the model admits it', async () => {
    const { ctx, handlers } = makeCtx(['low', 'medium', 'xhigh'])
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const result = await request({ agent: toolHistory() }, async () => seed) as Record<string, unknown>
    expect(result['reasoningEffort']).toBe('low')
  })

  it('clamps a mixed chain from high to medium on qwen3.8-max', async () => {
    const { ctx, handlers } = makeCtx(['low', 'medium', 'xhigh'])
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const agent = makeAgent([
      { type: 'tool/call', data: { name: 'mcp__docs', arguments: 'x'.repeat(1000), callId: 'c1' } },
    ])
    const result = await request({ agent }, async () => seed) as Record<string, unknown>
    expect(result['reasoningEffort']).toBe('medium')
  })

  it('leaves the request untouched when the model takes no effort', async () => {
    const { ctx, handlers } = makeCtx([])
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const result = await request({ agent: toolHistory() }, async () => seed)
    expect((result as Record<string, unknown>)['reasoningEffort']).toBeUndefined()
  })

  it('leaves the request untouched when capabilities cannot be resolved', async () => {
    const { ctx, handlers } = makeCtx(null)
    apply(ctx as never)
    const request = handlers.get('agent/request')!
    const result = await request({ agent: toolHistory() }, async () => seed)
    expect((result as Record<string, unknown>)['reasoningEffort']).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('returns the defaults for an absent config', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
  })

  it('keeps defaults for keys a partial config omits', () => {
    expect(resolveConfig({ baseline: 'low' })).toEqual({ ...DEFAULT_CONFIG, baseline: 'low' })
  })

  it('falls back to the default baseline for an unknown value', () => {
    expect(resolveConfig({ baseline: 'turbo' as never }).baseline).toBe('high')
  })

  it('honors an explicit opt-out', () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false)
  })
})
