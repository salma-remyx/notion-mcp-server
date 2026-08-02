/**
 * Optional tool-output compaction for the Notion MCP server.
 *
 * Adapted from "Agentic Context Management: Solving Agent Memory and Cost by
 * Treating Them as Lifecycle and Architecture Problems" (arXiv:2607.21503) —
 * specifically its "compacting & consolidation" primitive.
 *
 * Core mechanism (kept at full fidelity): the paper's economic argument is that
 * naive context accumulation grows token cost quadratically per turn, crude
 * summarization buys linear cost at the price of an accuracy cliff, and only
 * VALIDATED COMPACTION achieves linear cost while preserving fidelity. This
 * module realizes that validated compaction for the ballooning tool output a
 * Notion call returns: when a serialized response exceeds a budget, it is
 * compacted at STRUCTURAL boundaries (whole list items dropped, over-long
 * strings trimmed) rather than by slicing the serialized document. Every
 * retained item stays intact and each elision records its provenance, so the
 * agent can see what was elided and fetch it back if it turns out to matter —
 * linear token cost without the accuracy cliff of naive truncation.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's learned relevance / anticipation estimators (which decide
 *     what is "worth keeping") are replaced by a parameter-free budget proxy:
 *     head-of-array retention plus per-string length caps. No model call and no
 *     embedding store — the decision is deterministic and side-effect-free,
 *     matching the discipline the pre-execution write gate (arXiv:2607.07405)
 *     already follows in this module directory. Notion orders search and
 *     data-source results by relevance, so head retention is a reasonable
 *     zero-cost proxy for "most relevant first".
 *   - The paper's reference service "Maximem Synap" (a multi-tenant system
 *     spanning the full ACM lifecycle) is scoped down to a single in-process
 *     stage on the tool-response path. The other four ACM primitives
 *     (architecting, ingesting, scoping, anticipating) and the organizational
 *     scope hierarchy are intentionally out of scope for this PR.
 *   - The paper's evaluation framework (LongMemEval / LoCoMo) is cut; measuring
 *     fidelity preservation across compaction belongs in a downstream PR.
 *
 * Compaction is OFF by default (zero behavior change). Operators opt in via the
 * `NOTION_OUTPUT_COMPACTION` environment variable. See README for configuration.
 */

/** Operator policy the compaction stage is evaluated against. */
export type CompactionPolicy = {
  /** Master switch. When false the response is returned untouched (the default). */
  enabled: boolean
  /**
   * Soft character budget for the serialized tool output. Responses at or under
   * this size pass through unchanged (no fidelity loss); larger responses are
   * compacted. Roughly 4 chars ≈ 1 token.
   */
  maxChars?: number
  /** Max items retained per array when compacting; the tail is elided with a
   * provenance marker. */
  maxArrayItems?: number
  /** Max characters retained per string value when compacting; the rest is
   * elided with a provenance suffix. */
  maxStringLength?: number
}

/** Telemetry describing what a single compaction pass did (or did not do). */
export type CompactionStats = {
  /** True when any structural change was applied to the response. */
  compacted: boolean
  /** Serialized length of the original response (chars). */
  originalChars: number
  /** Serialized length of the compacted response (chars). */
  compactedChars: number
  /** Number of arrays whose tail was elided. */
  elidedArrays: number
  /** Number of string values that were trimmed. */
  truncatedStrings: number
}

export type CompactionResult = {
  data: unknown
  stats: CompactionStats
}

// Defaults applied when compaction is enabled but a limit is left unset. An
// ~8k-char budget keeps a typical tool response near 2k tokens while letting
// small responses pass through untouched (under-budget → zero change).
const DEFAULT_MAX_CHARS = 8000
const DEFAULT_MAX_ARRAY_ITEMS = 20
const DEFAULT_MAX_STRING_LENGTH = 480

// Guard against pathological nesting. Notion block trees are shallow, but the
// walk recurses through objects and arrays — bound it so adversarial input can
// never blow the stack.
const MAX_DEPTH = 32

const DISABLED_POLICY: CompactionPolicy = { enabled: false }

const resolveMaxChars = (policy: CompactionPolicy): number =>
  policy.maxChars && policy.maxChars > 0 ? policy.maxChars : DEFAULT_MAX_CHARS
const resolveMaxArrayItems = (policy: CompactionPolicy): number =>
  policy.maxArrayItems && policy.maxArrayItems > 0 ? policy.maxArrayItems : DEFAULT_MAX_ARRAY_ITEMS
const resolveMaxStringLength = (policy: CompactionPolicy): number =>
  policy.maxStringLength && policy.maxStringLength > 0 ? policy.maxStringLength : DEFAULT_MAX_STRING_LENGTH

/**
 * Serialized length of a value, in characters. Falls back to a best-effort
 * stringification if the value is not JSON-serializable (cycles, BigInt) so the
 * response path never throws on measurement.
 */
function measure(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}

/**
 * Load the compaction policy from the `NOTION_OUTPUT_COMPACTION` env variable.
 *
 * Accepts a JSON object (the full policy, with any limits overriding the
 * defaults) or the bare values `1`/`true` to enable with the default budget.
 * Anything unparseable or non-object falls back to the disabled default with a
 * warning, so a malformed env var can never accidentally enable compaction.
 */
export function loadCompactionPolicy(env: NodeJS.ProcessEnv = process.env): CompactionPolicy {
  const raw = env.NOTION_OUTPUT_COMPACTION
  if (!raw || raw.trim() === '') {
    return { ...DISABLED_POLICY }
  }

  const trimmed = raw.trim()
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return { enabled: true }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('NOTION_OUTPUT_COMPACTION must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    return normalizePolicy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_OUTPUT_COMPACTION environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

function normalizePolicy(parsed: Record<string, unknown>): CompactionPolicy {
  const asPositiveInt = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }
  return {
    enabled: parsed.enabled === true || parsed.enabled === 'true',
    maxChars: asPositiveInt(parsed.maxChars),
    maxArrayItems: asPositiveInt(parsed.maxArrayItems),
    maxStringLength: asPositiveInt(parsed.maxStringLength),
  }
}

type Counts = { elidedArrays: number; truncatedStrings: number }

/**
 * Walk a value and apply structure-preserving compaction: cap over-long arrays
 * (retaining the head, eliding the tail behind a provenance marker) and trim
 * over-long strings (recording how many characters were elided). Recurses into
 * objects and arrays. Pure, deterministic, side-effect-free apart from the
 * counters it increments for telemetry.
 */
function compactValue(
  value: unknown,
  maxArrayItems: number,
  maxStringLength: number,
  counts: Counts,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    return value
  }

  if (typeof value === 'string') {
    if (value.length > maxStringLength) {
      counts.truncatedStrings++
      const elided = value.length - maxStringLength
      return `${value.slice(0, maxStringLength)}... [+${elided} chars elided]`
    }
    return value
  }

  if (Array.isArray(value)) {
    if (value.length > maxArrayItems) {
      const kept = value.slice(0, maxArrayItems).map((item) =>
        compactValue(item, maxArrayItems, maxStringLength, counts, depth + 1),
      )
      counts.elidedArrays++
      kept.push({
        _compaction: {
          type: 'array-tail-elided',
          kept: maxArrayItems,
          elided: value.length - maxArrayItems,
        },
      })
      return kept
    }
    return value.map((item) => compactValue(item, maxArrayItems, maxStringLength, counts, depth + 1))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = compactValue(child, maxArrayItems, maxStringLength, counts, depth + 1)
    }
    return out
  }

  return value
}

/**
 * Compact a Notion tool response to the policy's budget using validated,
 * structure-preserving compaction.
 *
 * When the policy is disabled, or the response is already within budget, the
 * value is returned byte-for-byte unchanged (`compacted: false`). Otherwise a
 * single structural pass caps over-long arrays and strings, records provenance
 * for each elision, and returns the compacted value plus telemetry. The result
 * is always valid JSON — fidelity is preserved by eliding at item/field
 * boundaries, never by slicing the serialized document.
 */
export function compactResponse(data: unknown, policy: CompactionPolicy): CompactionResult {
  const originalChars = measure(data)

  if (!policy.enabled || originalChars <= resolveMaxChars(policy)) {
    return {
      data,
      stats: {
        compacted: false,
        originalChars,
        compactedChars: originalChars,
        elidedArrays: 0,
        truncatedStrings: 0,
      },
    }
  }

  const counts: Counts = { elidedArrays: 0, truncatedStrings: 0 }
  const compacted = compactValue(
    data,
    resolveMaxArrayItems(policy),
    resolveMaxStringLength(policy),
    counts,
    0,
  )

  return {
    data: compacted,
    stats: {
      compacted: true,
      originalChars,
      compactedChars: measure(compacted),
      elidedArrays: counts.elidedArrays,
      truncatedStrings: counts.truncatedStrings,
    },
  }
}
