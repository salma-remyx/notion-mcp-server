import { describe, expect, it } from 'vitest'
import { OpenAPIV3 } from 'openapi-types'

// Imports the existing converter (NON-NEW module) to prove the hardening pass is
// wired into the real tool-generation path, not just exercised in isolation.
import { OpenAPIToMCPConverter } from '../parser'
import {
  tightenInputSchema,
  loadSchemaHardeningPolicy,
  type SchemaHardeningPolicy,
} from '../schema-hardening'

// A Notion-shaped spec: a path param id declared `format: "uuid"`, a free-text
// query field, and a request body that references a parent object nesting
// another `page_id` uuid (mirrors Notion's pageIdParentRequest schema).
const notionishSpec = {
  openapi: '3.0.0',
  info: { title: 'Notion API', version: '1.0.0' },
  components: {
    schemas: {
      pageParentRequest: {
        type: 'object',
        properties: { page_id: { type: 'string', format: 'uuid' } },
        required: ['page_id'],
      },
    },
  },
  paths: {
    '/v1/pages/{page_id}': {
      get: {
        operationId: 'retrieve-a-page',
        summary: 'Retrieve a page',
        parameters: [
          {
            name: 'page_id',
            in: 'path',
            required: true,
            description: 'Identifier for a page',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'filter',
            in: 'query',
            description: 'Free-text filter expression',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/v1/pages': {
      post: {
        operationId: 'create-a-page',
        summary: 'Create a page',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { parent: { $ref: '#/components/schemas/pageParentRequest' } },
                required: ['parent'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
  },
} as unknown as OpenAPIV3.Document

const ENABLED: SchemaHardeningPolicy = { enabled: true, tightenIdFormat: true, boundStringFields: true }

// JSONSchema7Definition is `JSONSchema7 | false`, so read tool properties through
// `any` — matches the access style in parser.test.ts.
const paramOf = (method: { inputSchema: any }, name: string): any => method.inputSchema.properties[name]

describe('OpenAPIToMCPConverter — preemptive schema hardening (integration)', () => {
  it('is off by default: the generated schema is unchanged when no policy is set', () => {
    const converter = new OpenAPIToMCPConverter(notionishSpec)
    const { tools } = converter.convertToMCPTools()

    const pageIdParam = paramOf(tools.API.methods.find((m) => m.name === 'retrieve-a-page')!, 'page_id')
    // Advisory `format: uuid` is preserved, but no enforceable pattern is added.
    expect(pageIdParam).toMatchObject({ type: 'string', format: 'uuid' })
    expect(pageIdParam).not.toHaveProperty('pattern')
    expect(pageIdParam).not.toHaveProperty('maxLength')
  })

  it("tightens advisory `format: uuid` into an enforceable UUID pattern when enabled", () => {
    const converter = new OpenAPIToMCPConverter(notionishSpec, ENABLED)
    const { tools } = converter.convertToMCPTools()

    const pageIdParam = paramOf(tools.API.methods.find((m) => m.name === 'retrieve-a-page')!, 'page_id')
    // The advisory hint is now backed by a pattern the MCP input validator rejects on.
    expect(pageIdParam).toMatchObject({ type: 'string', format: 'uuid' })
    expect(pageIdParam.pattern as string).toContain('[0-9a-fA-F]{8}')
    expect(pageIdParam.maxLength).toBe(36)

    // A 32-hex Notion id (URL form) and a dashed UUID both pass; junk does not.
    const re = new RegExp(pageIdParam.pattern as string)
    expect('4e1234567890abcdef1234567890abcd').toMatch(re)
    expect('11111111-2222-3333-4444-555555555555').toMatch(re)
    expect('not-a-real-id').not.toMatch(re)
  })

  it('recurses into $defs so ids nested inside referenced objects are tightened', () => {
    const converter = new OpenAPIToMCPConverter(notionishSpec, ENABLED)
    const { tools } = converter.convertToMCPTools()

    const createMethod = tools.API.methods.find((m) => m.name === 'create-a-page')!
    const parentDef = createMethod.inputSchema.$defs!.pageParentRequest as {
      properties: { page_id: Record<string, unknown> }
    }
    expect(parentDef.properties.page_id.pattern).toBeDefined()
    expect(parentDef.properties.page_id.maxLength).toBe(36)
  })

  it('bounds unconstrained free-text strings when enabled (boundary sanitization)', () => {
    const converter = new OpenAPIToMCPConverter(notionishSpec, ENABLED)
    const { tools } = converter.convertToMCPTools()

    const filterParam = paramOf(tools.API.methods.find((m) => m.name === 'retrieve-a-page')!, 'filter')
    expect(filterParam).toMatchObject({ type: 'string' })
    expect(filterParam.maxLength).toBe(100000)
  })
})

describe('tightenInputSchema (unit)', () => {
  const base = {
    type: 'object' as const,
    properties: { page_id: { type: 'string' as const, format: 'uuid' } },
    required: ['page_id'],
  }

  it('returns the schema untouched when disabled', () => {
    const out = tightenInputSchema(base, { enabled: false, tightenIdFormat: true, boundStringFields: true })
    expect(out).toEqual(base)
  })

  it('is pure: the input is not mutated', () => {
    const input = {
      type: 'object' as const,
      properties: { page_id: { type: 'string' as const, format: 'uuid' } },
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    tightenInputSchema(input, ENABLED)
    expect(input).toEqual(snapshot)
  })
})

describe('loadSchemaHardeningPolicy (unit)', () => {
  it('is disabled by default and on any malformed value', () => {
    expect(loadSchemaHardeningPolicy({}).enabled).toBe(false)
    expect(loadSchemaHardeningPolicy({ NOTION_SCHEMA_HARDENING: 'not-json{' }).enabled).toBe(false)
    expect(loadSchemaHardeningPolicy({ NOTION_SCHEMA_HARDENING: '[]' }).enabled).toBe(false)
  })

  it('enables both rules for 1/true', () => {
    const p = loadSchemaHardeningPolicy({ NOTION_SCHEMA_HARDENING: 'true' })
    expect(p).toEqual({ enabled: true, tightenIdFormat: true, boundStringFields: true })
  })

  it('toggles rules individually via JSON object', () => {
    const p = loadSchemaHardeningPolicy({ NOTION_SCHEMA_HARDENING: '{"enabled":true,"boundStringFields":false}' })
    expect(p).toEqual({ enabled: true, tightenIdFormat: true, boundStringFields: false })
  })
})
