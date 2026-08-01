/**
 * Condense the per-tool "Error Responses" block that the OpenAPI -> MCP
 * parser appends to every tool description.
 *
 * Adapted from the insight in "Prompt Design at Scale: How Format,
 * Instruction Count, and Context Length Shape Instruction Adherence and
 * Hallucination in Large Language Models" (arXiv:2607.19257): added
 * instruction surface is pure token overhead (+22-37% over plain text),
 * instruction count degrades adherence, and no formatting choice reliably
 * helps. The Error Responses block is exactly this kind of low-value,
 * high-cost surface -- each line restates an HTTP status code whose meaning
 * the code already conveys.
 *
 * `condenseErrorResponses` drops the boilerplate prose (keeping just the
 * code) while preserving any tool-specific error detail verbatim, and
 * collapses the multi-line block into a compact single line: strictly fewer
 * tokens and instructions with no loss of actionable signal.
 */

// HTTP status codes whose standard meaning a bare description merely restates.
// When a response's description normalizes to one of these for its code, the
// prose is redundant with the code and is dropped (the code already conveys it).
const BOILERPLATE_BY_CODE: Readonly<Record<string, ReadonlySet<string>>> = {
  '400': new Set(['bad request', '400']),
  '401': new Set(['unauthorized', 'unauthorised']),
  '402': new Set(['payment required']),
  '403': new Set(['forbidden']),
  '404': new Set(['not found']),
  '405': new Set(['method not allowed']),
  '409': new Set(['conflict']),
  '410': new Set(['gone']),
  '412': new Set(['precondition failed']),
  '413': new Set(['payload too large', 'request entity too large']),
  '415': new Set(['unsupported media type']),
  '422': new Set(['unprocessable entity']),
  '429': new Set(['rate limited', 'too many requests']),
  '500': new Set(['internal server error', 'server error']),
  '501': new Set(['not implemented']),
  '502': new Set(['bad gateway']),
  '503': new Set(['service unavailable']),
  '504': new Set(['gateway timeout']),
}

const ERROR_RESPONSES_MARKER = 'Error Responses:'

function normalizeDescription(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
}

function isBoilerplate(code: string, description: string): boolean {
  const known = BOILERPLATE_BY_CODE[code]
  if (!known) {
    return false
  }
  return known.has(normalizeDescription(description))
}

/**
 * Collapse the "Error Responses" block at the tail of a tool description into
 * a compact single-line "Errors: ..." summary. Boilerplate descriptions
 * (e.g. "400: Bad request") reduce to their code; tool-specific detail
 * (e.g. "403: The integration lacks ...") is preserved verbatim. Returns the
 * input unchanged when no block is present.
 */
export function condenseErrorResponses(description: string): string {
  const markerIndex = description.indexOf(ERROR_RESPONSES_MARKER)
  if (markerIndex === -1) {
    return description
  }

  const before = description.slice(0, markerIndex).replace(/\n+$/, '')
  const afterMarker = description
    .slice(markerIndex + ERROR_RESPONSES_MARKER.length)
    .replace(/^\n+/, '')

  // The parser appends this block last, so it runs to the end of the string.
  // Stop at the first blank line just in case trailing prose was appended.
  const entries: string[] = []
  for (const line of afterMarker.split('\n')) {
    if (line.trim() === '') {
      break
    }
    const match = line.match(/^(\d{3}):\s*(.*)$/)
    if (!match) {
      // Not an error-response line -- treat as the end of the block.
      break
    }
    const code = match[1]
    const detail = match[2].trim()
    if (detail === '' || isBoilerplate(code, detail)) {
      entries.push(code)
    } else {
      entries.push(`${code}: ${detail}`)
    }
  }

  if (entries.length === 0) {
    // No usable error entries: drop the marker entirely.
    return before
  }

  const compact = `Errors: ${entries.join(', ')}`
  return before === '' ? compact : `${before}\n${compact}`
}
