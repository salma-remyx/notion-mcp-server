import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  ALL_CANARY_TYPES,
  buildCanaryTools,
  canaryResponse,
  findCanaryByName,
  loadCanaryConfig,
  type CanaryConfig,
  type CanaryTool,
} from '../canary-tools'
import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'

// Match the mocking pattern used in proxy.test.ts / write-gate.test.ts:
// HttpClient and the MCP Server SDK are mocked so we can drive the list-tools
// and call-tool handlers directly and assert what (if anything) reached Notion.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

describe('loadCanaryConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('is disabled when NOTION_CANARY_TOOLS is unset', () => {
    delete process.env.NOTION_CANARY_TOOLS
    expect(loadCanaryConfig()).toEqual({ enabled: false })
  })

  it('enables all six probes on "true" / "1"', () => {
    process.env.NOTION_CANARY_TOOLS = 'true'
    expect(loadCanaryConfig()).toEqual({ enabled: true })
    process.env.NOTION_CANARY_TOOLS = '1'
    expect(loadCanaryConfig().enabled).toBe(true)
  })

  it('parses a JSON config with a type subset', () => {
    process.env.NOTION_CANARY_TOOLS = JSON.stringify({
      enabled: true,
      types: ['semantic-decoy', 'capability-mirage'],
    })
    expect(loadCanaryConfig()).toEqual({
      enabled: true,
      types: ['semantic-decoy', 'capability-mirage'],
    })
  })

  it('drops unknown taxonomy types and falls back to all when none are known', () => {
    process.env.NOTION_CANARY_TOOLS = JSON.stringify({ enabled: true, types: ['bogus'] })
    expect(loadCanaryConfig()).toEqual({ enabled: true, types: undefined })
  })

  it('falls back to disabled on invalid JSON (never accidentally plants canaries)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.NOTION_CANARY_TOOLS = 'not json'
    expect(loadCanaryConfig().enabled).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('buildCanaryTools', () => {
  it('returns nothing when disabled', () => {
    expect(buildCanaryTools({ enabled: false })).toEqual([])
  })

  it('builds one canary per taxonomy slot by default', () => {
    const canaries = buildCanaryTools({ enabled: true })
    expect(canaries).toHaveLength(ALL_CANARY_TYPES.length)
    const types = canaries.map((c) => c.type).sort()
    expect(types).toEqual([...ALL_CANARY_TYPES].sort())
  })

  it('respects a configured type subset', () => {
    const canaries = buildCanaryTools({ enabled: true, types: ['semantic-decoy'] })
    expect(canaries).toHaveLength(1)
    expect(canaries[0].type).toBe('semantic-decoy')
  })

  it('shapes each canary like a real Notion tool (name, schema, fair annotations)', () => {
    const canaries = buildCanaryTools({ enabled: true })
    const decoy = canaries.find((c) => c.type === 'semantic-decoy')!
    expect(decoy.tool.name).toBe('retrieve-document-summary')
    expect(decoy.tool.inputSchema.type).toBe('object')
    expect(decoy.tool.annotations).toMatchObject({ title: 'Retrieve Document Summary', readOnlyHint: true })
    expect(decoy.marker).toBe('canary:semantic-decoy:retrieve-document-summary')
  })

  it('marks the write-shaped canary destructive instead of read-only', () => {
    const canaries = buildCanaryTools({ enabled: true })
    const append = canaries.find((c) => c.type === 'prerequisite-blindness')!
    expect(append.tool.annotations).toMatchObject({ destructiveHint: true })
    expect(append.tool.annotations).not.toHaveProperty('readOnlyHint')
  })
})

describe('canaryResponse', () => {
  it('emits a structured canary payload carrying the stable marker', () => {
    const canary = buildCanaryTools({ enabled: true, types: ['capability-mirage'] })[0]
    const result = canaryResponse(canary, { page_id: 'p1' })
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('canary')
    expect(payload.type).toBe('capability-mirage')
    expect(payload.marker).toBe(canary.marker)
    expect(payload.message).toContain('export-page-as-pdf')
    expect(payload.arguments).toEqual({ page_id: 'p1' })
  })

  it('normalizes a missing arguments object to {}', () => {
    const canary = buildCanaryTools({ enabled: true, types: ['granularity-trap'] })[0]
    const payload = JSON.parse(canaryResponse(canary, undefined).content[0].text)
    expect(payload.arguments).toEqual({})
  })
})

describe('canary tools wired into MCPProxy', () => {
  let proxy: MCPProxy
  let listToolsHandler: () => Promise<{ tools: Array<{ name: string }> }>
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

    const server = (
      proxy as unknown as {
        server: { setRequestHandler: { mock: { calls: unknown[][] } } }
      }
    ).server
    const handlers = server.setRequestHandler.mock.calls.flat().filter((x: unknown) => typeof x === 'function')
    listToolsHandler = handlers[0] as typeof listToolsHandler
    callToolHandler = handlers[1] as typeof callToolHandler
  })

  const enableCanaries = (config: CanaryConfig = { enabled: true }) => {
    ;(proxy as unknown as { canaries: CanaryTool[] }).canaries = buildCanaryTools(config)
    ;(proxy as unknown as { canaryConfig: CanaryConfig }).canaryConfig = config
  }

  it('does not inject canaries when disabled (the default — real tool list untouched)', async () => {
    const { tools } = await listToolsHandler()
    expect(tools).toEqual([])
  })

  it('injects the canary probe tools into the tool list when enabled', async () => {
    enableCanaries()
    const { tools } = await listToolsHandler()
    const names = tools.map((t) => t.name)
    expect(names).toContain('retrieve-document-summary')
    expect(names).toContain('export-page-as-pdf')
    expect(names).toHaveLength(ALL_CANARY_TYPES.length)
  })

  it('returns a structured canary response and never calls Notion when a canary is invoked', async () => {
    enableCanaries()
    const result = (await callToolHandler({
      params: { name: 'retrieve-document-summary', arguments: { document_id: 'p1' } },
    })) as { content: { text: string }[] }

    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
    const payload = JSON.parse(result.content[0].text)
    expect(payload.status).toBe('canary')
    expect(payload.type).toBe('semantic-decoy')
    expect(payload.marker).toContain('retrieve-document-summary')
  })

  it('still routes unknown (non-canary) tool names to the normal missing-operation path', async () => {
    enableCanaries()
    await expect(
      callToolHandler({ params: { name: 'not-a-real-tool', arguments: {} } }),
    ).rejects.toThrow('not found')
    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
  })

  it('findCanaryByName matches the injected tool name', () => {
    const canaries = buildCanaryTools({ enabled: true })
    expect(findCanaryByName(canaries, 'export-page-as-pdf')?.type).toBe('capability-mirage')
    expect(findCanaryByName(canaries, 'retrieve-a-page')).toBeUndefined()
  })
})
