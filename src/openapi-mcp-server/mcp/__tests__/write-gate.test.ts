import { describe, expect, it, beforeEach, vi } from 'vitest'
import { evaluateWriteGate, loadWriteGatePolicy } from '../write-gate'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Match the mocking pattern used in proxy.test.ts: HttpClient and the MCP
// Server SDK are mocked so we can drive the call-tool handler directly and
// assert what (if anything) reached executeOperation.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const patchOp = (operationId: string, path: string) =>
  ({
    operationId,
    responses: { '200': { description: 'Success' } },
    method: 'patch',
    path,
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

describe('evaluateWriteGate', () => {
  it('allows everything when the policy is disabled', () => {
    const decision = evaluateWriteGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: false,
      deniedOperations: ['update-page'],
      allowedTargetIds: [],
    })
    expect(decision.allowed).toBe(true)
  })

  it('always allows read-only (GET) operations even when enabled', () => {
    const getOp = { operationId: 'retrieve-page', method: 'get', path: '/pages/{page_id}' } as OpenAPIV3.OperationObject & {
      method: string
      path: string
    }
    const decision = evaluateWriteGate(getOp, { page_id: 'p1' }, {
      enabled: true,
      allowedTargetIds: ['some-other-page'],
    })
    expect(decision.allowed).toBe(true)
  })

  it('denies an operation on the denied list (case-insensitive)', () => {
    const decision = evaluateWriteGate(patchOp('Archive-a-Page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      deniedOperations: ['archive-a-page'],
    })
    expect(decision.allowed).toBe(false)
    expect(decision).toMatchObject({ gate: 'denied-operation' })
    expect((decision as { reason: string }).reason).toContain('Archive-a-Page')
  })

  it('denies a write whose top-level target id is not on the allowlist', () => {
    const decision = evaluateWriteGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'p1' }, {
      enabled: true,
      allowedTargetIds: ['allowed-page'],
    })
    expect(decision.allowed).toBe(false)
    expect(decision).toMatchObject({ gate: 'target-allowlist' })
    expect((decision as { reason: string }).reason).toContain('p1')
  })

  it('allows a write whose target id is on the allowlist', () => {
    const decision = evaluateWriteGate(patchOp('update-page', '/pages/{page_id}'), { page_id: 'allowed-page' }, {
      enabled: true,
      allowedTargetIds: ['allowed-page'],
    })
    expect(decision.allowed).toBe(true)
  })

  it('denies a write whose nested parent target is not on the allowlist', () => {
    const decision = evaluateWriteGate(
      { operationId: 'create-a-page', method: 'post', path: '/pages' } as OpenAPIV3.OperationObject & {
        method: string
        path: string
      },
      { parent: { database_id: 'db-not-allowed' } },
      { enabled: true, allowedTargetIds: ['db-ok'] },
    )
    expect(decision.allowed).toBe(false)
    expect((decision as { reason: string }).reason).toContain('db-not-allowed')
  })

  it('fails open when a write has no inspectable target id', () => {
    const decision = evaluateWriteGate(
      { operationId: 'search', method: 'post', path: '/search' } as OpenAPIV3.OperationObject & {
        method: string
        path: string
      },
      { query: 'hello' },
      { enabled: true, allowedTargetIds: ['only-this'] },
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('loadWriteGatePolicy', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('is disabled when NOTION_WRITE_GATE is unset', () => {
    delete process.env.NOTION_WRITE_GATE
    expect(loadWriteGatePolicy()).toEqual({ enabled: false })
  })

  it('enables with no rules on "true" / "1"', () => {
    process.env.NOTION_WRITE_GATE = 'true'
    expect(loadWriteGatePolicy()).toEqual({ enabled: true })
    process.env.NOTION_WRITE_GATE = '1'
    expect(loadWriteGatePolicy().enabled).toBe(true)
  })

  it('parses a full JSON policy object', () => {
    process.env.NOTION_WRITE_GATE = JSON.stringify({
      enabled: true,
      deniedOperations: ['archive-a-page'],
      allowedTargetIds: ['page-1', 'page-2'],
    })
    expect(loadWriteGatePolicy()).toEqual({
      enabled: true,
      deniedOperations: ['archive-a-page'],
      allowedTargetIds: ['page-1', 'page-2'],
    })
  })

  it('falls back to disabled on invalid JSON (never accidentally enables)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_WRITE_GATE = 'not json'
    expect(loadWriteGatePolicy().enabled).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to disabled when the value is valid JSON but not an object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_WRITE_GATE = '["enabled"]'
    expect(loadWriteGatePolicy().enabled).toBe(false)
    warnSpy.mockRestore()
  })
})

describe('write gate wired into MCPProxy call-tool handler', () => {
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

  it('blocks a policy-violating write before it reaches the Notion API', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-update-page': patchOp('update-page', '/pages/{page_id}'),
    }
    // Allowlist only permits "safe-page"; the agent targets something else.
    ;(proxy as unknown as { writeGatePolicy: { enabled: boolean; allowedTargetIds: string[] } }).writeGatePolicy = {
      enabled: true,
      allowedTargetIds: ['safe-page'],
    }

    const result = (await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'dangerous-page', data: {} } },
    })) as { content: { text: string }[] }

    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('error')
    expect(payload.message).toContain('write gate')
    expect(payload.message).toContain('dangerous-page')
  })

  it('lets an allowed write through to the Notion API', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-update-page': patchOp('update-page', '/pages/{page_id}'),
    }
    ;(proxy as unknown as { writeGatePolicy: { enabled: boolean; allowedTargetIds: string[] } }).writeGatePolicy = {
      enabled: true,
      allowedTargetIds: ['safe-page'],
    }

    const result = (await callToolHandler({
      params: { name: 'notion-update-page', arguments: { page_id: 'safe-page', data: {} } },
    })) as { content: { text: string }[] }

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ok' })
  })
})
