import { describe, expect, it, beforeEach, vi } from 'vitest'
import { compactResponse, loadCompactionPolicy } from '../compaction'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Match the mocking pattern used in proxy.test.ts / write-gate.test.ts: HttpClient
// and the MCP Server SDK are mocked so we can drive the call-tool handler
// directly and assert what reached the agent.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const getOp = (operationId: string, path: string) =>
  ({
    operationId,
    responses: { '200': { description: 'Success' } },
    method: 'get',
    path,
  }) as OpenAPIV3.OperationObject & { method: string; path: string }

describe('compactResponse', () => {
  it('returns the value unchanged when the policy is disabled', () => {
    const data = { results: [{ id: 'a' }, { id: 'b' }] }
    const { data: out, stats } = compactResponse(data, { enabled: false })
    expect(out).toBe(data)
    expect(stats.compacted).toBe(false)
    expect(stats.originalChars).toBe(stats.compactedChars)
  })

  it('returns the value unchanged when enabled but already within budget', () => {
    const data = { results: [{ id: 'a' }] }
    const { data: out, stats } = compactResponse(data, { enabled: true, maxChars: 100_000 })
    expect(out).toBe(data)
    expect(stats.compacted).toBe(false)
  })

  it('elides the tail of an over-long array and records provenance', () => {
    const data = { results: Array.from({ length: 50 }, (_, i) => ({ id: `b-${i}` })) }
    const { data: out, stats } = compactResponse(data, {
      enabled: true,
      maxChars: 1,
      maxArrayItems: 3,
    })
    const compacted = out as { results: Array<{ id: string } | { _compaction: unknown }> }
    // 3 retained items + 1 provenance marker
    expect(compacted.results).toHaveLength(4)
    expect((compacted.results[3] as { _compaction: { elided: number } })._compaction.elided).toBe(47)
    // Each retained item is intact (not sliced) — fidelity preserved.
    expect((compacted.results[0] as { id: string }).id).toBe('b-0')
    expect(stats.compacted).toBe(true)
    expect(stats.elidedArrays).toBe(1)
    expect(stats.compactedChars).toBeLessThan(stats.originalChars)
  })

  it('trims over-long strings with a provenance suffix, not a hard slice', () => {
    const data = { text: 'x'.repeat(600) }
    const { data: out, stats } = compactResponse(data, {
      enabled: true,
      maxChars: 1,
      maxStringLength: 10,
    })
    const text = (out as { text: string }).text
    expect(text).toContain('[+590 chars elided]')
    expect(text.startsWith('xxxxxxxxxx')).toBe(true)
    // Output remains valid JSON (round-trips cleanly — no accuracy cliff).
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(stats.truncatedStrings).toBe(1)
    expect(stats.compacted).toBe(true)
  })

  it('keeps valid JSON and preserves short values untouched in a mixed response', () => {
    const data = {
      page_id: 'abc',
      short: 'keep me',
      results: Array.from({ length: 30 }, (_, i) => ({ id: `r-${i}` })),
    }
    const { data: out } = compactResponse(data, {
      enabled: true,
      maxChars: 1,
      maxArrayItems: 5,
    })
    const compacted = out as { page_id: string; short: string; results: unknown[] }
    expect(compacted.page_id).toBe('abc')
    expect(compacted.short).toBe('keep me')
    expect(compacted.results).toHaveLength(6)
  })
})

describe('loadCompactionPolicy', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('is disabled when NOTION_OUTPUT_COMPACTION is unset', () => {
    delete process.env.NOTION_OUTPUT_COMPACTION
    expect(loadCompactionPolicy()).toEqual({ enabled: false })
  })

  it('enables with defaults on "true" / "1"', () => {
    process.env.NOTION_OUTPUT_COMPACTION = 'true'
    expect(loadCompactionPolicy()).toEqual({ enabled: true })
    process.env.NOTION_OUTPUT_COMPACTION = '1'
    expect(loadCompactionPolicy().enabled).toBe(true)
  })

  it('parses a full JSON policy object with custom limits', () => {
    process.env.NOTION_OUTPUT_COMPACTION = JSON.stringify({
      enabled: true,
      maxChars: 4096,
      maxArrayItems: 10,
    })
    expect(loadCompactionPolicy()).toEqual({
      enabled: true,
      maxChars: 4096,
      maxArrayItems: 10,
      maxStringLength: undefined,
    })
  })

  it('falls back to disabled on invalid JSON (never accidentally enables)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_OUTPUT_COMPACTION = 'not json'
    expect(loadCompactionPolicy().enabled).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to disabled when the value is valid JSON but not an object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_OUTPUT_COMPACTION = '["enabled"]'
    expect(loadCompactionPolicy().enabled).toBe(false)
    warnSpy.mockRestore()
  })
})

describe('compaction wired into MCPProxy call-tool handler', () => {
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

    ;(proxy as unknown as { openApiLookup: Record<string, unknown> }).openApiLookup = {
      'notion-retrieve-page': getOp('retrieve-page', '/pages/{page_id}'),
    }
  })

  it('compacts a ballooning response and preserves JSON fidelity', async () => {
    const bigData = {
      results: Array.from({ length: 50 }, (_, i) => ({
        id: `block-${i}`,
        rich_text: 'y'.repeat(800),
      })),
    }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: bigData,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    // Tight budget so the response is well over the limit.
    ;(proxy as unknown as { compactionPolicy: { enabled: boolean; maxChars: number; maxArrayItems: number; maxStringLength: number } }).compactionPolicy = {
      enabled: true,
      maxChars: 1000,
      maxArrayItems: 5,
      maxStringLength: 20,
    }

    const result = (await callToolHandler({
      params: { name: 'notion-retrieve-page', arguments: { page_id: 'p1' } },
    })) as { content: { text: string }[] }

    const payload = JSON.parse(result.content[0].text)
    const results = payload.results as unknown[]
    // 5 retained items + 1 provenance marker — the tail was elided, not sliced.
    expect(results).toHaveLength(6)
    expect((results[5] as { _compaction: { elided: number } })._compaction.elided).toBe(45)
    // Retained items had their over-long strings trimmed, with a provenance suffix.
    const firstText = (results[0] as { rich_text: string }).rich_text
    expect(firstText).toContain('[+')
    expect(firstText.length).toBeLessThan(800)
    // Output is dramatically smaller than the raw response.
    expect(result.content[0].text.length).toBeLessThan(JSON.stringify(bigData).length)
  })

  it('passes a small response through unchanged when under budget', async () => {
    const smallData = { results: [{ id: 'only-one' }] }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: smallData,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    ;(proxy as unknown as { compactionPolicy: { enabled: boolean; maxChars: number } }).compactionPolicy = {
      enabled: true,
      maxChars: 100_000,
    }

    const result = (await callToolHandler({
      params: { name: 'notion-retrieve-page', arguments: { page_id: 'p1' } },
    })) as { content: { text: string }[] }

    expect(JSON.parse(result.content[0].text)).toEqual(smallData)
  })

  it('returns the raw response untouched when compaction is disabled (default)', async () => {
    const data = { results: Array.from({ length: 50 }, (_, i) => ({ id: `block-${i}` })) }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    // Policy stays as constructed: disabled because NOTION_OUTPUT_COMPACTION is unset.
    ;(proxy as unknown as { compactionPolicy: { enabled: boolean } }).compactionPolicy = {
      enabled: false,
    }

    const result = (await callToolHandler({
      params: { name: 'notion-retrieve-page', arguments: { page_id: 'p1' } },
    })) as { content: { text: string }[] }

    expect(JSON.parse(result.content[0].text)).toEqual(data)
  })
})
