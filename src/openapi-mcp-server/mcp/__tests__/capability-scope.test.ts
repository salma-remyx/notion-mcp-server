import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  classifyOperationTier,
  classifyTaskTier,
  evaluateCapabilityScope,
  loadCapabilityScopePolicy,
} from '../capability-scope'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Match the mocking pattern used in write-gate.test.ts: HttpClient and the MCP
// Server SDK are mocked so we can drive the call-tool handler directly and
// assert what (if anything) reached executeOperation.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const op = (operationId: string, method: string, path = '/x') =>
  ({
    operationId,
    responses: { '200': { description: 'Success' } },
    method,
    path,
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

describe('classifyOperationTier', () => {
  it('classifies GET and the non-GET query reads as read', () => {
    expect(classifyOperationTier(op('retrieve-a-page', 'get'))).toBe('read')
    expect(classifyOperationTier(op('post-search', 'post'))).toBe('read')
    expect(classifyOperationTier(op('query-data-source', 'post'))).toBe('read')
  })

  it('classifies comment operations as comment', () => {
    expect(classifyOperationTier(op('create-a-comment', 'post'))).toBe('comment')
    // reading a comment is still a read
    expect(classifyOperationTier(op('retrieve-a-comment', 'get'))).toBe('read')
  })

  it('classifies mutating content operations as write', () => {
    expect(classifyOperationTier(op('patch-page', 'patch'))).toBe('write')
    expect(classifyOperationTier(op('post-page', 'post'))).toBe('write')
    expect(classifyOperationTier(op('move-page', 'post'))).toBe('write')
  })

  it('classifies a DELETE and any archive/trash operation as destructive', () => {
    expect(classifyOperationTier(op('delete-a-block', 'delete'))).toBe('destructive')
    expect(classifyOperationTier(op('archive-a-page', 'post'))).toBe('destructive')
  })
})

describe('classifyTaskTier', () => {
  it('defaults to read (least privilege) when nothing stronger is asked for', () => {
    expect(classifyTaskTier('summarize the meeting notes')).toBe('read')
    expect(classifyTaskTier('find the Q3 roadmap page')).toBe('read')
  })

  it('promotes to comment for discussion tasks', () => {
    expect(classifyTaskTier('reply to the open comment thread')).toBe('comment')
  })

  it('promotes to write for editing tasks', () => {
    expect(classifyTaskTier('update the launch checklist')).toBe('write')
    expect(classifyTaskTier('create a new onboarding page')).toBe('write')
  })

  it('promotes to destructive and wins over weaker signals in the same task', () => {
    expect(classifyTaskTier('read the page and then permanently delete it')).toBe('destructive')
    expect(classifyTaskTier('archive last quarter drafts')).toBe('destructive')
  })
})

describe('evaluateCapabilityScope', () => {
  it('allows everything when disabled', () => {
    const decision = evaluateCapabilityScope(op('delete-a-block', 'delete'), {}, { enabled: false })
    expect(decision.allowed).toBe(true)
    expect(decision.observed).toBeUndefined()
  })

  it('is a no-op when enabled but no source is configured', () => {
    const decision = evaluateCapabilityScope(op('delete-a-block', 'delete'), {}, { enabled: true })
    expect(decision.allowed).toBe(true)
  })

  it('denies an operation above the role ceiling (scopes reads AND writes)', () => {
    const decision = evaluateCapabilityScope(op('patch-page', 'patch'), {}, {
      enabled: true,
      roleCeiling: 'read',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.source).toBe('role-ceiling')
    expect(decision.opTier).toBe('write')
    expect(decision.ceiling).toBe('read')
  })

  it('allows an operation at or below the role ceiling', () => {
    expect(
      evaluateCapabilityScope(op('retrieve-a-page', 'get'), {}, {
        enabled: true,
        roleCeiling: 'comment',
      }).allowed,
    ).toBe(true)
    expect(
      evaluateCapabilityScope(op('create-a-comment', 'post'), {}, {
        enabled: true,
        roleCeiling: 'comment',
      }).allowed,
    ).toBe(true)
  })

  it('binds to the most-restrictive source: task narrows a wider role ceiling', () => {
    // Role allows up to destructive, but the task only needs read. A write must
    // be denied and the binding source must be the task-context classifier.
    const decision = evaluateCapabilityScope(op('patch-page', 'patch'), {}, {
      enabled: true,
      roleCeiling: 'destructive',
      taskContext: 'read the meeting notes',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.source).toBe('task-context')
    expect(decision.ceiling).toBe('read')
  })

  it('observe-only mode lets the call through while recording the mismatch', () => {
    const decision = evaluateCapabilityScope(op('delete-a-block', 'delete'), {}, {
      enabled: true,
      enforce: false,
      roleCeiling: 'read',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.observed).toBe(true)
    expect(decision.opTier).toBe('destructive')
    expect(decision.ceiling).toBe('read')
  })
})

describe('loadCapabilityScopePolicy', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('is disabled when NOTION_CAPABILITY_SCOPE is unset', () => {
    delete process.env.NOTION_CAPABILITY_SCOPE
    expect(loadCapabilityScopePolicy()).toEqual({ enabled: false })
  })

  it('enables in enforcing mode on "true" / "1"', () => {
    process.env.NOTION_CAPABILITY_SCOPE = 'true'
    expect(loadCapabilityScopePolicy()).toEqual({ enabled: true, enforce: true })
    process.env.NOTION_CAPABILITY_SCOPE = '1'
    expect(loadCapabilityScopePolicy()).toEqual({ enabled: true, enforce: true })
  })

  it('parses a full JSON policy with both sources', () => {
    process.env.NOTION_CAPABILITY_SCOPE = JSON.stringify({
      enabled: true,
      roleCeiling: 'write',
      taskContext: 'update the roadmap',
    })
    expect(loadCapabilityScopePolicy()).toEqual({
      enabled: true,
      enforce: true,
      roleCeiling: 'write',
      taskContext: 'update the roadmap',
    })
  })

  it('respects an explicit observe-only (enforce: false) flag', () => {
    process.env.NOTION_CAPABILITY_SCOPE = JSON.stringify({
      enabled: true,
      enforce: false,
      roleCeiling: 'read',
    })
    expect(loadCapabilityScopePolicy().enforce).toBe(false)
  })

  it('ignores an invalid tier string rather than widening scope', () => {
    process.env.NOTION_CAPABILITY_SCOPE = JSON.stringify({
      enabled: true,
      roleCeiling: 'superadmin',
    })
    const policy = loadCapabilityScopePolicy()
    expect(policy.roleCeiling).toBeUndefined()
  })

  it('falls back to disabled on invalid JSON (never accidentally enables)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_CAPABILITY_SCOPE = 'not json'
    expect(loadCapabilityScopePolicy().enabled).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('capability-scope gate wired into MCPProxy call-tool handler', () => {
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

  it('blocks a write above a read-only role ceiling before it reaches the Notion API', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-patch-page': op('patch-page', 'patch', '/pages/{page_id}'),
    }
    ;(proxy as unknown as { capabilityScopePolicy: { enabled: boolean; roleCeiling: string } }).capabilityScopePolicy = {
      enabled: true,
      roleCeiling: 'read',
    }

    const result = (await callToolHandler({
      params: { name: 'notion-patch-page', arguments: { page_id: 'p1', data: {} } },
    })) as { content: { text: string }[] }

    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('error')
    expect(payload.message).toContain('capability-scope gate')
    expect(payload.message).toContain('role-ceiling')
  })

  it('lets an in-scope read through to the Notion API under a read-only ceiling', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-retrieve-a-page': op('retrieve-a-page', 'get', '/pages/{page_id}'),
    }
    ;(proxy as unknown as { capabilityScopePolicy: { enabled: boolean; roleCeiling: string } }).capabilityScopePolicy = {
      enabled: true,
      roleCeiling: 'read',
    }

    const result = (await callToolHandler({
      params: { name: 'notion-retrieve-a-page', arguments: { page_id: 'p1' } },
    })) as { content: { text: string }[] }

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ok' })
  })

  it('observe-only mode lets an out-of-scope write through but records the signal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuccess)
    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-delete-a-block': op('delete-a-block', 'delete', '/blocks/{block_id}'),
    }
    ;(proxy as unknown as { capabilityScopePolicy: { enabled: boolean; enforce: boolean; roleCeiling: string } }).capabilityScopePolicy = {
      enabled: true,
      enforce: false,
      roleCeiling: 'read',
    }

    const result = (await callToolHandler({
      params: { name: 'notion-delete-a-block', arguments: { block_id: 'b1' } },
    })) as { content: { text: string }[] }

    // The call proceeds (observe-only), but the out-of-scope request is logged.
    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ok' })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('observe-only'),
      expect.objectContaining({ operationId: 'delete-a-block' }),
    )
    warnSpy.mockRestore()
  })
})
