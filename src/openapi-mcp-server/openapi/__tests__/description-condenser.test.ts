import { describe, expect, it } from 'vitest'
import { OpenAPIV3 } from 'openapi-types'
import { condenseErrorResponses } from '../description-condenser'
import { OpenAPIToMCPConverter } from '../parser'

describe('condenseErrorResponses', () => {
  it('leaves descriptions without an Error Responses block untouched', () => {
    const description = 'Create a comment'
    expect(condenseErrorResponses(description)).toBe(description)
  })

  it('drops boilerplate prose, keeping only the status code', () => {
    const description = 'Create a comment\nError Responses:\n400: Bad request'
    expect(condenseErrorResponses(description)).toBe('Create a comment\nErrors: 400')
  })

  it('treats a description that merely restates the code as boilerplate', () => {
    const description = 'Retrieve a user\nError Responses:\n400: 400'
    expect(condenseErrorResponses(description)).toBe('Retrieve a user\nErrors: 400')
  })

  it('preserves tool-specific error detail verbatim and keeps codes in order', () => {
    const description =
      'Retrieve a page as Markdown\n' +
      'Error Responses:\n' +
      '400: Bad request\n' +
      '403: The integration lacks the read/update content capability required for this page.\n' +
      '404: Page not found or not shared with the integration.\n' +
      '429: Rate limited.'
    expect(condenseErrorResponses(description)).toBe(
      'Retrieve a page as Markdown\n' +
        'Errors: 400, 403: The integration lacks the read/update content capability required for this page., ' +
        '404: Page not found or not shared with the integration., 429',
    )
  })

  it('matches boilerplate case- and punctuation-insensitively', () => {
    const description = 'Search\nError Responses:\n429: Rate Limited.'
    expect(condenseErrorResponses(description)).toBe('Search\nErrors: 429')
  })

  it('removes the marker entirely when no error entries remain', () => {
    const description = 'Do thing\nError Responses:\n'
    expect(condenseErrorResponses(description)).toBe('Do thing')
  })

  it('reduces the description length for the common boilerplate case', () => {
    const description = 'Create a comment\nError Responses:\n400: Bad request'
    expect(condenseErrorResponses(description).length).toBeLessThan(description.length)
  })
})

describe('OpenAPIToMCPConverter description condensing (integration)', () => {
  // Exercises the wiring in parser.ts:getDescription, which runs every
  // generated tool description through condenseErrorResponses.
  const spec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: { title: 'Notion API', version: '1.0.0' },
    paths: {
      '/pages/{page_id}': {
        get: {
          operationId: 'retrieve-page',
          summary: 'Retrieve a page',
          responses: {
            '200': { description: 'ok' },
            '400': { description: 'Bad request' },
            '403': { description: 'The integration lacks the read/update content capability required for this page.' },
            '429': { description: 'Rate limited.' },
          },
        },
      },
    },
  }

  it('condenses the Error Responses block on generated Notion tools', () => {
    const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
    const method = tools.API.methods.find((m) => m.name === 'retrieve-page')
    expect(method).toBeDefined()

    // Prefix still applied; boilerplate (400, 429) reduced to codes; tool-
    // specific 403 detail preserved verbatim; block collapsed to one line.
    expect(method?.description).toBe(
      'Notion | Retrieve a page\n' +
        'Errors: 400, 403: The integration lacks the read/update content capability required for this page., 429',
    )
    expect(method?.description).not.toContain('Error Responses:')
    expect(method?.description).not.toContain('Bad request')
    expect(method?.description).not.toContain('Rate limited.')
  })
})
