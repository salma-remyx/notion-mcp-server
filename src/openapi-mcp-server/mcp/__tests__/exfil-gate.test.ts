import { describe, expect, it, beforeEach, vi } from 'vitest'
import { evaluateExfilGate, extractParamUrls, loadExfilGatePolicy } from '../exfil-gate'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Match the mocking pattern used in write-gate.test.ts: HttpClient and the MCP
// Server SDK are mocked so we can drive the call-tool handler directly and
// assert what (if anything) reached executeOperation.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const commentOp = () =>
  ({
    operationId: 'create-a-comment',
    responses: { '200': { description: 'Success' } },
    method: 'post',
    path: '/comments',
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

describe('extractParamUrls', () => {
  it('finds URLs in top-level strings, prose, and nested block structures', () => {
    const urls = extractParamUrls({
      page_id: 'p1',
      rich_text: [{ text: { content: 'see https://notion.so/docs and http://evil.example.com/x?a=1' } }],
      children: [{ type: 'bookmark', bookmark: { url: 'https://attacker.test/payload' } }],
    })
    expect(urls).toContain('https://notion.so/docs')
    expect(urls).toContain('http://evil.example.com/x?a=1')
    expect(urls).toContain('https://attacker.test/payload')
    expect(urls).toHaveLength(3)
  })

  it('returns nothing for params with no URLs', () => {
    expect(extractParamUrls({ query: 'quarterly review', page_id: 'p1' })).toEqual([])
  })

  it('does not match non-http schemes', () => {
    expect(extractParamUrls({ text: 'mailto:a@b.test and file:///etc/passwd' })).toEqual([])
  })
})

describe('evaluateExfilGate', () => {
  it('allows everything when the policy is disabled', () => {
    const decision = evaluateExfilGate(
      commentOp(),
      { rich_text: [{ text: { content: 'https://evil.test' } }] },
      { enabled: false },
    )
    expect(decision.allowed).toBe(true)
  })

  it('allows Notion-host URLs when enabled with the default allowlist', () => {
    const decision = evaluateExfilGate(
      commentOp(),
      { rich_text: [{ text: { content: 'docs at https://www.notion.so/guide and https://sub.notion.site/x' } }] },
      { enabled: true },
    )
    expect(decision.allowed).toBe(true)
  })

  it('denies an embedded URL pointing at a non-allowlisted host', () => {
    const decision = evaluateExfilGate(
      commentOp(),
      { rich_text: [{ text: { content: 'summary at https://evil.example.com/c2?d=1' } }] },
      { enabled: true },
    )
    expect(decision.allowed).toBe(false)
    expect(decision).toMatchObject({ gate: 'external-url' })
    expect((decision as { reason: string }).reason).toContain('evil.example.com')
  })

  it('denies a smuggled URL inside a bookmark block, including a JSON-string param', () => {
    // Double-encoded param, as clients that trigger deserializeParams send it:
    // the URL survives deserialization and is still caught.
    const params = {
      children: [
        {
          type: 'bookmark',
          bookmark: JSON.stringify({ url: 'https://attacker.test/payload' }),
        },
      ],
    }
    const decision = evaluateExfilGate(commentOp(), params, { enabled: true })
    expect(decision.allowed).toBe(false)
    expect((decision as { reason: string }).reason).toContain('attacker.test')
  })

  it('respects a custom host allowlist including subdomains', () => {
    const decision = evaluateExfilGate(
      commentOp(),
      { text: 'https://cdn.mycompany.com/logo.png and https://notion.so/x' },
      { enabled: true, allowedUrlHosts: ['mycompany.com'] },
    )
    // notion.so is not on the custom allowlist — a custom list replaces defaults
    expect(decision.allowed).toBe(false)
    expect((decision as { reason: string }).reason).toContain('notion.so')
    expect((decision as { reason: string }).reason).not.toContain('cdn.mycompany.com')
  })

  it('does not treat a lookalike suffix as an allowed subdomain', () => {
    const decision = evaluateExfilGate(
      commentOp(),
      { text: 'https://notion.so.evil.test/x' },
      { enabled: true },
    )
    expect(decision.allowed).toBe(false)
    expect((decision as { reason: string }).reason).toContain('notion.so.evil.test')
  })

  it('applies to read operations too (GET carries the same smuggling channel)', () => {
    const getOp = {
      operationId: 'retrieve-a-page',
      method: 'get',
      path: '/pages/{page_id}',
    } as OpenAPIV3.OperationObject & { method: string; path: string }
    const decision = evaluateExfilGate(getOp, { query: 'fetch https://evil.test/notes' }, { enabled: true })
    expect(decision.allowed).toBe(false)
  })
})

describe('loadExfilGatePolicy', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.NOTION_EXFIL_GATE
  })

  it('defaults to disabled when the env var is unset', () => {
    expect(loadExfilGatePolicy()).toEqual({ enabled: false })
  })

  it('enables with bare 1/true', () => {
    process.env.NOTION_EXFIL_GATE = 'true'
    expect(loadExfilGatePolicy()).toEqual({ enabled: true })
    process.env.NOTION_EXFIL_GATE = '1'
    expect(loadExfilGatePolicy()).toEqual({ enabled: true })
  })

  it('parses a JSON policy', () => {
    process.env.NOTION_EXFIL_GATE = '{"enabled":true,"allowedUrlHosts":["corp.internal"]}'
    expect(loadExfilGatePolicy()).toEqual({ enabled: true, allowedUrlHosts: ['corp.internal'] })
  })

  it('falls back to disabled on unparseable input', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_EXFIL_GATE = 'not json'
    expect(loadExfilGatePolicy()).toEqual({ enabled: false })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to disabled on non-object JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_EXFIL_GATE = '"string"'
    expect(loadExfilGatePolicy()).toEqual({ enabled: false })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('exfil gate wired into MCPProxy callTool handler', () => {
  let proxy: MCPProxy

  const buildProxy = (): { callToolHandler: (request: unknown) => Promise<unknown> } => {
    const server = (proxy as unknown as { server: { setRequestHandler: { mock: { calls: unknown[][] } } } }).server
    const handlers = server.setRequestHandler.mock.calls
      .flatMap((x: unknown[]) => x)
      .filter((x: unknown) => typeof x === 'function')
    return { callToolHandler: handlers[1] as (request: unknown) => Promise<unknown> }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    const mockOpenApiSpec = {
      openapi: '3.0.0',
      servers: [{ url: 'http://localhost:3000' }],
      info: { title: 'Test API', version: '1.0.0' },
      paths: {
        '/comments': {
          post: {
            operationId: 'create-a-comment',
            responses: { '200': { description: 'Success' } },
          },
        },
      },
    } as unknown as OpenAPIV3.Document

    proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
    ;(proxy as unknown as Record<string, unknown>).openApiLookup = {
      'API-create-a-comment': {
        operationId: 'create-a-comment',
        responses: { '200': { description: 'Success' } },
        method: 'post',
        path: '/comments',
      },
    }
  })

  it('denies a comment carrying a non-allowlisted URL instead of executing it', async () => {
    const { callToolHandler } = buildProxy()
    ;(proxy as unknown as { exfilGatePolicy: unknown }).exfilGatePolicy = { enabled: true }

    const result = (await callToolHandler({
      params: {
        name: 'API-create-a-comment',
        arguments: {
          rich_text: [{ text: { content: 'Notes rendered at https://evil.example.com/viewer' } }],
        },
      },
    })) as { content: Array<{ text: string }> }

    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('error')
    expect(payload.message).toContain('exfiltration gate')
    expect(payload.message).toContain('evil.example.com')
    // Nothing reached the Notion API
    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
  })

  it('executes normally when the URL points at an allowlisted host', async () => {
    const { callToolHandler } = buildProxy()
    ;(proxy as unknown as { exfilGatePolicy: unknown }).exfilGatePolicy = { enabled: true }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'comment-1' },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    await callToolHandler({
      params: {
        name: 'API-create-a-comment',
        arguments: {
          rich_text: [{ text: { content: 'docs: https://www.notion.so/help' } }],
        },
      },
    })

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
  })

  it('executes normally when the gate is disabled (default policy)', async () => {
    const { callToolHandler } = buildProxy()
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: 'comment-2' },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    await callToolHandler({
      params: {
        name: 'API-create-a-comment',
        arguments: {
          rich_text: [{ text: { content: 'https://anything.example.com' } }],
        },
      },
    })

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
  })
})
