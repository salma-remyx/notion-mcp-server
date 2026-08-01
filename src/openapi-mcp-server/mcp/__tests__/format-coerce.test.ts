import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { HttpClient } from '../../client/http-client'
import { coerceParamFormats, coerceValue } from '../format-coerce'
import { describe, expect, it, vi } from 'vitest'

// Mock the dependencies the same way proxy.test.ts does, so MCPProxy can be
// constructed without a live server or HTTP client.
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

// A spec whose tool exposes the three IFEval-FC format-instruction categories:
// an enum, an integer, and a date — built through the REAL converter so the
// wiring (spec -> inputSchemaLookup) is exercised, not stubbed.
function specWithFormatParams(): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    servers: [{ url: 'http://localhost:3000' }],
    info: { title: 'Test API', version: '1.0.0' },
    paths: {
      '/items': {
        post: {
          operationId: 'createItem',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['Active', 'Archived'] } },
            { name: 'count', in: 'query', schema: { type: 'integer' } },
            { name: 'due', in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          responses: { '200': { description: 'Success' } },
        },
      },
    },
  }
}

function extractCallToolHandler(proxy: MCPProxy): (request: unknown) => Promise<unknown> {
  const server = (proxy as any).server
  const handlers = server.setRequestHandler.mock.calls
    .flat()
    .filter((x: unknown) => typeof x === 'function')
  return handlers[1]
}

describe('MCPProxy format coercion (IFEval-FC, arXiv:2509.18420v1)', () => {
  it('repairs enum casing, integer-as-string, and slash dates before executeOperation', async () => {
    const proxy = new MCPProxy('test-proxy', specWithFormatParams())
    const callToolHandler = extractCallToolHandler(proxy)

    const mockResponse = {
      data: { id: 'item-1' },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

    await callToolHandler({
      params: {
        // operationId createItem -> tool name 'API-createItem' (converter hardcodes the 'API' group)
        name: 'API-createItem',
        arguments: {
          status: 'active', // wrong casing/whitespace vs enum
          count: '42', // integer sent as a string
          due: '2024/03/15', // slash date against format: date
        },
      },
    })

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'Active',
        count: 42,
        due: '2024-03-15',
      }),
    )
  })
})

describe('coerceParamFormats (direct)', () => {
  const schema: IJsonSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['Active', 'Archived'] },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      ratio: { type: 'number' },
      due: { type: 'string', format: 'date' },
      label: { type: 'string' },
    },
  }

  it('coerces scalar types, enums, and dates against the schema', () => {
    expect(
      coerceParamFormats(
        { status: ' archived ', count: '7', flag: 'true', ratio: '3.5', due: '2024/01/02' },
        schema,
      ),
    ).toEqual({ status: 'Archived', count: 7, flag: true, ratio: 3.5, due: '2024-01-02' })
  })

  it('leaves schema-agnostic values and genuine strings untouched', () => {
    // No schema at all -> pass-through (the contract the existing
    // "should not coerce scalar or quoted-scalar string params" test relies on).
    expect(coerceParamFormats({ count: '123', flag: 'true', quoted: '"hello"' })).toEqual({
      count: '123',
      flag: 'true',
      quoted: '"hello"',
    })
    // String-typed field with stray quotes is preserved, not unwrapped.
    expect(coerceParamFormats({ label: '"hello"', count: 9 }, schema)).toEqual({
      label: '"hello"',
      count: 9,
    })
  })

  it('does not coerce ambiguous or out-of-range values', () => {
    expect(coerceParamFormats({ count: '42.5', ratio: 'NaN', due: 'not-a-date' }, schema)).toEqual({
      count: '42.5',
      ratio: 'NaN',
      due: 'not-a-date',
    })
    // Enum with no case-insensitive match stays as-is.
    expect(coerceParamFormats({ status: 'pending' }, schema)).toEqual({ status: 'pending' })
  })

  it('recurses into arrays and anyOf-wrapped item schemas', () => {
    // withStringFallback wraps array items in anyOf: [item, string, object].
    const arraySchema: IJsonSchema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { anyOf: [{ type: 'string', enum: ['Red', 'Blue'] }, { type: 'string' }] },
        },
      },
    }
    expect(coerceParamFormats({ tags: ['red', 'blue', 'green'] }, arraySchema)).toEqual({
      tags: ['Red', 'Blue', 'green'],
    })
  })
})

describe('coerceValue (direct)', () => {
  it('returns the value unchanged when no schema is provided', () => {
    expect(coerceValue('anything')).toBe('anything')
    expect(coerceValue('42', undefined)).toBe('42')
  })

  it('normalizes a slash date-time to ISO only when it parses', () => {
    expect(coerceValue('2024/03/15T10:00:00Z', { type: 'string', format: 'date-time' })).toBe(
      '2024-03-15T10:00:00Z',
    )
    // Already ISO date-time is left untouched.
    expect(coerceValue('2024-03-15T10:00:00Z', { type: 'string', format: 'date-time' })).toBe(
      '2024-03-15T10:00:00Z',
    )
  })
})
