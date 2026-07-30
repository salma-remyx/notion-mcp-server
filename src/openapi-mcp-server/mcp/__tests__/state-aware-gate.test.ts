import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  evaluateStateAwareGate,
  loadStateAwareGatePolicy,
  normalizeTargetState,
  resolveStateRead,
  runStateAwareGate,
  type StateGateDeps,
} from '../state-aware-gate'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Same mocking pattern as write-gate.test.ts / proxy.test.ts: HttpClient and the
// MCP Server SDK are mocked so we can drive the call-tool handler directly and
// assert which operations (read round-trip vs. write) reached executeOperation.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const patchOp = (operationId: string, path: string) =>
  ({
    operationId,
    responses: { '200': { description: 'Success' } },
    method: 'patch',
    path,
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

const getOp = (operationId: string, path: string) =>
  ({
    operationId,
    responses: { '200': { description: 'Success' } },
    method: 'get',
    path,
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

describe('resolveStateRead', () => {
  it('maps a write target id to the read that fetches its state', () => {
    expect(resolveStateRead({ page_id: 'p1', data: {} })).toEqual({
      paramKey: 'page_id',
      operationId: 'retrieve-a-page',
      targetId: 'p1',
    })
    expect(resolveStateRead({ block_id: 'b1' })?.operationId).toBe('retrieve-a-block')
    expect(resolveStateRead({ data_source_id: 'ds1' })?.operationId).toBe('retrieve-a-data-source')
  })

  it('returns null when the write carries no inspectable target id', () => {
    expect(resolveStateRead({ query: 'hello' })).toBeNull()
  })
})

describe('normalizeTargetState', () => {
  it('pulls the archived flag out of a retrieve response', () => {
    expect(normalizeTargetState({ id: 'p1', archived: true })).toEqual({ archived: true })
    expect(normalizeTargetState({ id: 'p1', archived: false })).toEqual({ archived: false })
  })

  it('returns empty state for an unrecognized shape (fail open)', () => {
    expect(normalizeTargetState({ id: 'p1' })).toEqual({})
    expect(normalizeTargetState(null)).toEqual({})
    expect(normalizeTargetState('oops')).toEqual({})
  })
})

describe('evaluateStateAwareGate', () => {
  it('allows everything when the policy is disabled', () => {
    const decision = evaluateStateAwareGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: false,
      denyWritesToArchived: true,
    }, { archived: true })
    expect(decision.allowed).toBe(true)
  })

  it('always allows reads even when the target is archived', () => {
    const decision = evaluateStateAwareGate(getOp('retrieve-a-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      denyWritesToArchived: true,
    }, { archived: true })
    expect(decision.allowed).toBe(true)
  })

  it('denies a write whose current state is archived', () => {
    const decision = evaluateStateAwareGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      denyWritesToArchived: true,
    }, { archived: true })
    expect(decision.allowed).toBe(false)
    expect(decision).toMatchObject({ gate: 'state-archived-target' })
    expect((decision as { reason: string }).reason).toContain('p1')
    expect((decision as { reason: string }).reason).toContain('archived')
  })

  it('allows the write when the target is not archived', () => {
    const decision = evaluateStateAwareGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      denyWritesToArchived: true,
    }, { archived: false })
    expect(decision.allowed).toBe(true)
  })

  it('fails open when current state is unknown', () => {
    const decision = evaluateStateAwareGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      denyWritesToArchived: true,
    }, {})
    expect(decision.allowed).toBe(true)
  })
})

describe('loadStateAwareGatePolicy', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('is disabled when NOTION_STATE_GATE is unset', () => {
    delete process.env.NOTION_STATE_GATE
    expect(loadStateAwareGatePolicy()).toEqual({ enabled: false })
  })

  it('enables with the default predicate on "true" / "1"', () => {
    process.env.NOTION_STATE_GATE = 'true'
    expect(loadStateAwareGatePolicy()).toEqual({ enabled: true, denyWritesToArchived: true })
    process.env.NOTION_STATE_GATE = '1'
    expect(loadStateAwareGatePolicy()).toEqual({ enabled: true, denyWritesToArchived: true })
  })

  it('defaults the predicate on when enabling via JSON without specifying it', () => {
    process.env.NOTION_STATE_GATE = '{"enabled":true}'
    expect(loadStateAwareGatePolicy()).toEqual({ enabled: true, denyWritesToArchived: true })
  })

  it('honors an explicit denyWritesToArchived:false', () => {
    process.env.NOTION_STATE_GATE = '{"enabled":true,"denyWritesToArchived":false}'
    expect(loadStateAwareGatePolicy()).toEqual({ enabled: true, denyWritesToArchived: false })
  })

  it('falls back to disabled on invalid JSON (never accidentally enables)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_STATE_GATE = 'not json'
    expect(loadStateAwareGatePolicy().enabled).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('runStateAwareGate (orchestrator with injected deps)', () => {
  const writeOp = patchOp('update-page', '/pages/{page_id}')
  const enabledPolicy = { enabled: true, denyWritesToArchived: true }

  const depsOf = (overrides: Partial<StateGateDeps> = {}): StateGateDeps => ({
    resolveReadOperation: overrides.resolveReadOperation ?? (() => ({ operationId: 'retrieve-a-page' })),
    readState: overrides.readState ?? (async () => ({ archived: false })),
  })

  it('denies when the round-tripped state is archived', async () => {
    const decision = await runStateAwareGate(
      writeOp,
      { page_id: 'p1' },
      enabledPolicy,
      depsOf({ readState: async () => ({ archived: true }) }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision).toMatchObject({ gate: 'state-archived-target' })
  })

  it('allows when the round-tripped state is live', async () => {
    const decision = await runStateAwareGate(
      writeOp,
      { page_id: 'p1' },
      enabledPolicy,
      depsOf({ readState: async () => ({ archived: false }) }),
    )
    expect(decision.allowed).toBe(true)
  })

  it('fails open when no target id can be resolved to a read', async () => {
    const readState = vi.fn()
    const decision = await runStateAwareGate(writeOp, { query: 'no target' }, enabledPolicy, {
      resolveReadOperation: () => null,
      readState,
    })
    expect(decision.allowed).toBe(true)
    expect(readState).not.toHaveBeenCalled()
  })

  it('fails open when the read operation is not registered', async () => {
    const decision = await runStateAwareGate(
      writeOp,
      { page_id: 'p1' },
      enabledPolicy,
      depsOf({ resolveReadOperation: () => null }),
    )
    expect(decision.allowed).toBe(true)
  })

  it('fails open (and warns) when the state read throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const decision = await runStateAwareGate(
      writeOp,
      { page_id: 'p1' },
      enabledPolicy,
      depsOf({ readState: async () => { throw new Error('boom') } }),
    )
    expect(decision.allowed).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('skips the round-trip entirely when the policy is disabled', async () => {
    const readState = vi.fn()
    const decision = await runStateAwareGate(writeOp, { page_id: 'p1' }, { enabled: false }, {
      resolveReadOperation: () => null,
      readState,
    })
    expect(decision.allowed).toBe(true)
    expect(readState).not.toHaveBeenCalled()
  })
})

describe('state-aware gate wired into MCPProxy call-tool handler', () => {
  let proxy: MCPProxy
  let callToolHandler: (request: { params: { name: string; arguments?: unknown } }) => Promise<unknown>

  beforeEach(() => {
    vi.clearAllMocks()

    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      servers: [{ url: 'http://localhost:3000' }],
      info: { title: 'Test API', version: '1.0.0' },
      paths: {},
    }
    proxy = new MCPProxy('test-proxy', spec)

    const server = (proxy as unknown as { server: { setRequestHandler: { mock: { calls: unknown[][] } } } }).server
    const handlers = server.setRequestHandler.mock.calls
      .flat()
      .filter((x: unknown) => typeof x === 'function')
    callToolHandler = handlers[1] as typeof callToolHandler
  })

  const mockSuccess = {
    data: { id: 'ok' },
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
  }

  const installLookup = () => {
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-update-page': patchOp('update-page', '/pages/{page_id}'),
      'notion-retrieve-a-page': getOp('retrieve-a-page', '/pages/{page_id}'),
    }
  }

  it('reads the world before a write and blocks a write to an archived target', async () => {
    installLookup()
    ;(proxy as unknown as { stateGatePolicy: { enabled: boolean; denyWritesToArchived: boolean } }).stateGatePolicy = {
      enabled: true,
      denyWritesToArchived: true,
    }
    // First (and only) executeOperation is the state read: the page is archived.
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'p1', archived: true },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    const result = (await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'p1', data: {} } },
    })) as { content: { text: string }[] }

    const calls = (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    // The single call was the state read (retrieve-a-page), not the write.
    expect((calls[0][0] as { operationId: string }).operationId).toBe('retrieve-a-page')
    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('error')
    expect(payload.message).toContain('state gate')
    expect(payload.message).toContain('archived')
    expect(payload.message).toContain('p1')
  })

  it('reads the world then lets a write through when the target is live', async () => {
    installLookup()
    ;(proxy as unknown as { stateGatePolicy: { enabled: boolean; denyWritesToArchived: boolean } }).stateGatePolicy = {
      enabled: true,
      denyWritesToArchived: true,
    }
    // First call: state read (live page). Second call: the write succeeds.
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: { id: 'p1', archived: false }, status: 200, headers: new Headers() })
      .mockResolvedValueOnce(mockSuccess)

    const result = (await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'p1', data: {} } },
    })) as { content: { text: string }[] }

    const calls = (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect((calls[0][0] as { operationId: string }).operationId).toBe('retrieve-a-page')
    expect((calls[1][0] as { operationId: string }).operationId).toBe('update-page')
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ok' })
  })

  it('fails open (lets the write through) when the state read errors', async () => {
    installLookup()
    ;(proxy as unknown as { stateGatePolicy: { enabled: boolean; denyWritesToArchived: boolean } }).stateGatePolicy = {
      enabled: true,
      denyWritesToArchived: true,
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // First call: read throws. Second call: write succeeds.
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(mockSuccess)

    const result = (await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'p1', data: {} } },
    })) as { content: { text: string }[] }

    const calls = (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ok' })
    warnSpy.mockRestore()
  })

  it('performs no round-trip when the gate is disabled (zero behavior change)', async () => {
    installLookup()
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)

    await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'p1', data: {} } },
    })

    const calls = (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    // The only call is the write — no state read was issued.
    expect((calls[0][0] as { operationId: string }).operationId).toBe('update-page')
  })
})
