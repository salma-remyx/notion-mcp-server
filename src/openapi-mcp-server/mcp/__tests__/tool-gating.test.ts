import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OpenAPIV3 } from 'openapi-types'

import { MCPProxy } from '../proxy'
import {
  deriveCategory,
  gatingOptionsFromEnv,
  selectTool,
  summarizeDescription,
  type GatableTool,
} from '../tool-gating'

// Mock the same dependencies the proxy tests mock, so constructing MCPProxy in
// these integration cases stays hermetic.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const getListToolsHandler = (proxy: MCPProxy) => {
  const server = (proxy as any).server
  return server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
}

// A small spec spanning two resource categories and three HTTP methods, with
// 4xx responses so the parser appends the per-tool "Error Responses" block that
// lazy-schema trimming targets.
const buildSpec = (): OpenAPIV3.Document => ({
  openapi: '3.0.0',
  servers: [{ url: 'http://localhost:3000' }],
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/v1/pages/{page_id}': {
      get: {
        operationId: 'getPage',
        summary: 'Get a page',
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
      patch: {
        operationId: 'updatePage',
        summary: 'Update a page',
        responses: { '200': { description: 'OK' }, '400': { description: 'Bad request' } },
      },
    },
    '/v1/databases/{database_id}': {
      post: {
        operationId: 'queryDatabase',
        summary: 'Query a database',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
})

describe('tool-gating (pure module)', () => {
  describe('deriveCategory', () => {
    it('extracts the resource segment after a version prefix', () => {
      expect(deriveCategory('/v1/pages/{page_id}')).toBe('pages')
      expect(deriveCategory('/v1/blocks/{block_id}/children')).toBe('blocks')
      expect(deriveCategory('/v1/data_sources/{id}')).toBe('data_sources')
    })

    it('handles paths without a version prefix and empty paths', () => {
      expect(deriveCategory('/search')).toBe('search')
      expect(deriveCategory('')).toBe('')
    })
  })

  describe('summarizeDescription', () => {
    it('keeps only the first line, dropping the appended error block', () => {
      const description = 'Get a page\nError Responses:\n404: Not found'
      expect(summarizeDescription(description)).toBe('Get a page')
    })

    it('returns the description untouched when it is already a single line', () => {
      expect(summarizeDescription('Query a database')).toBe('Query a database')
    })

    it('passes empty descriptions through', () => {
      expect(summarizeDescription('')).toBe('')
    })
  })

  describe('selectTool', () => {
    const pageGet: GatableTool = {
      name: 'API-getPage',
      description: 'Get a page\nError Responses:\n404: Not found',
      inputSchema: { type: 'object' },
      method: 'get',
      path: '/v1/pages/{page_id}',
    }
    const pagePatch: GatableTool = { ...pageGet, name: 'API-updatePage', method: 'patch' }
    const dbPost: GatableTool = {
      name: 'API-queryDatabase',
      description: 'Query a database',
      inputSchema: { type: 'object' },
      method: 'post',
      path: '/v1/databases/{database_id}',
    }

    it('keeps every tool when mode is off (default)', () => {
      expect(selectTool(pageGet, {})).toEqual(pageGet)
      expect(selectTool(pagePatch, { mode: 'off' })).toEqual(pagePatch)
    })

    it('keeps only GET operations under read-only mode', () => {
      expect(selectTool(pageGet, { mode: 'read-only' })).toEqual(pageGet)
      expect(selectTool(pagePatch, { mode: 'read-only' })).toBeNull()
      expect(selectTool(dbPost, { mode: 'read-only' })).toBeNull()
    })

    it('filters by resource category under category mode', () => {
      expect(selectTool(pageGet, { mode: 'category', categories: ['pages'] })).toEqual(pageGet)
      expect(selectTool(dbPost, { mode: 'category', categories: ['pages'] })).toBeNull()
      // An empty allowlist is a no-op (keeps everything) rather than dropping all.
      expect(selectTool(dbPost, { mode: 'category', categories: [] })).toEqual(dbPost)
    })

    it('filters by tool name under names mode', () => {
      expect(selectTool(pageGet, { mode: 'names', names: ['API-getPage'] })).toEqual(pageGet)
      expect(selectTool(pagePatch, { mode: 'names', names: ['API-getPage'] })).toBeNull()
    })

    it('collapses the description to a summary when lazySchema is on', () => {
      const selected = selectTool(pageGet, { lazySchema: true })
      expect(selected).not.toBeNull()
      expect(selected!.description).toBe('Get a page')
      // inputSchema is forwarded unchanged so the tool stays callable.
      expect(selected!.inputSchema).toEqual({ type: 'object' })
    })

    it('combines gating with lazy-schema trimming', () => {
      const selected = selectTool(pageGet, { mode: 'read-only', lazySchema: true })
      expect(selected).not.toBeNull()
      expect(selected!.description).toBe('Get a page')
    })
  })

  describe('gatingOptionsFromEnv', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('defaults to off with no lists when nothing is set', () => {
      delete process.env.MCP_TOOL_GATING_MODE
      delete process.env.MCP_TOOL_GATING_CATEGORIES
      delete process.env.MCP_TOOL_GATING_NAMES
      delete process.env.MCP_TOOL_GATING_LAZY_SCHEMA
      expect(gatingOptionsFromEnv()).toEqual({
        mode: 'off',
        categories: [],
        names: [],
        lazySchema: false,
      })
    })

    it('parses mode, comma-separated lists, and the lazy flag', () => {
      process.env.MCP_TOOL_GATING_MODE = 'category'
      process.env.MCP_TOOL_GATING_CATEGORIES = 'pages, blocks '
      process.env.MCP_TOOL_GATING_LAZY_SCHEMA = '1'
      expect(gatingOptionsFromEnv()).toEqual({
        mode: 'category',
        categories: ['pages', 'blocks'],
        names: [],
        lazySchema: true,
      })
    })

    it('accepts readonly and truthy variants', () => {
      process.env.MCP_TOOL_GATING_MODE = 'readonly'
      process.env.MCP_TOOL_GATING_LAZY_SCHEMA = 'true'
      const options = gatingOptionsFromEnv()
      expect(options.mode).toBe('read-only')
      expect(options.lazySchema).toBe(true)
    })

    it('falls back to off on an unrecognized mode', () => {
      process.env.MCP_TOOL_GATING_MODE = 'bogus'
      expect(gatingOptionsFromEnv().mode).toBe('off')
    })
  })
})

// Integration: the wiring lives in MCPProxy.setupHandlers() (the call site). The
// cases below construct a real MCPProxy and drive its ListTools handler, so they
// exercise the existing call-site module, not just the new file.
describe('MCPProxy tool gating (integration through the call site)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes every tool with full descriptions when no options are given', async () => {
    const proxy = new MCPProxy('test-proxy', buildSpec())
    const result = await getListToolsHandler(proxy)()

    const names = result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(['API-getPage', 'API-updatePage', 'API-queryDatabase'])

    const getPage = result.tools.find((t: { name: string }) => t.name === 'API-getPage')
    // Verbose description (with the error block) is preserved in the default path.
    expect(getPage.description).toContain('Error Responses')
  })

  it('gates to read-only operations', async () => {
    const proxy = new MCPProxy('test-proxy', buildSpec(), undefined, { mode: 'read-only' })
    const result = await getListToolsHandler(proxy)()

    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['API-getPage'])
  })

  it('gates to a resource category derived from the OpenAPI path', async () => {
    const proxy = new MCPProxy('test-proxy', buildSpec(), undefined, {
      mode: 'category',
      categories: ['pages'],
    })
    const result = await getListToolsHandler(proxy)()

    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      'API-getPage',
      'API-updatePage',
    ])
  })

  it('trims each tool description to a one-line summary under lazySchema', async () => {
    const proxy = new MCPProxy('test-proxy', buildSpec(), undefined, { lazySchema: true })
    const result = await getListToolsHandler(proxy)()

    const getPage = result.tools.find((t: { name: string }) => t.name === 'API-getPage')
    expect(getPage.description).toBe('Get a page')
    // inputSchema remains present so the tool is still callable.
    expect(getPage.inputSchema).toBeDefined()
  })
})
