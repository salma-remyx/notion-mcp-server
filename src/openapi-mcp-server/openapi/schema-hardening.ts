import type { JSONSchema7 as IJsonSchema } from 'json-schema'

/**
 * Preemptive schema hardening for the Notion MCP server.
 *
 * Adapted from "Data Leakage Prevention in Agentic Applications via Preemptive
 * Hardening" (arXiv:2607.18847). The paper's *hardening stage* applies
 * minimally-invasive mitigations to a tool's interface before deployment —
 * specifically "schema tightening" and "boundary sanitization" — so leakage- and
 * misuse-enabling inputs are rejected at the interface boundary rather than
 * caught (or missed) at runtime.
 *
 * That maps directly onto this server: `OpenAPIToMCPConverter` already emits a
 * JSON Schema per tool, and the MCP layer validates every tool call against that
 * schema before the request reaches the Notion API. So tightening the *schema*
 * is tightening the *gate* — and it is static (generated once at startup), which
 * is exactly the paper's "without the need of continuous runtime policy
 * enforcement" property.
 *
 * Core mechanism (kept at full fidelity): a pure JSON-Schema-in → tightened-
 * JSON-Schema-out transform that turns *advisory* constraints into *enforceable*
 * ones. Notion's OpenAPI spec declares resource ids (`page_id`, `database_id`,
 * `block_id`, ...) with `format: "uuid"`, but `format` is only a hint — the MCP
 * input validator does not reject a non-UUID against it. The transform adds an
 * enforceable `pattern` (UUID) and a length cap to those fields, and bounds
 * otherwise-unbounded free-text strings with a generous `maxLength`.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's full scan/patch-generation pipeline is replaced by a single,
 *     deterministic, parameter-free transform applied to the schema the
 *     converter already produces — no separate analyzer or patch format.
 *   - The paper's *validation stage* (auto-generated adversarial prompt-
 *     injection attacks + benign variants) is intentionally scoped out. It is a
 *     separate eval framework and belongs in a downstream PR; here the
 *     mitigations are deliberately conservative (they only add constraints that
 *     every legitimate Notion value already satisfies) so they cannot disrupt
 *     intended behavior.
 *   - The paper's "allowlist-based tool gating" mitigation already ships here as
 *     the runtime `NOTION_WRITE_GATE` (see mcp/write-gate.ts); this module
 *     delivers the complementary *schema-tightening* half at generation time.
 *
 * The pass is OFF by default (zero behavior change). Operators opt in via the
 * `NOTION_SCHEMA_HARDENING` environment variable. See README for configuration.
 */

/** Policy the schema-hardening pass is evaluated against. */
export interface SchemaHardeningPolicy {
  /** Master switch. When false the schema is returned unchanged (the default). */
  enabled: boolean
  /**
   * Add an enforceable UUID `pattern` (and a length cap) to id-shaped string
   * fields — those declared `format: "uuid"` in the spec or whose name ends in
   * `_id` / is `id`. This is the paper's "schema tightening" mitigation: an
   * advisory hint becomes a constraint the MCP input validator rejects on.
   */
  tightenIdFormat: boolean
  /**
   * Add a generous `maxLength` to free-text string fields that carry no length
   * bound. This is the paper's "boundary sanitization" mitigation: it blocks
   * unbounded payloads while staying well above any legitimate value size.
   */
  boundStringFields: boolean
}

const DISABLED_POLICY: SchemaHardeningPolicy = {
  enabled: false,
  tightenIdFormat: false,
  boundStringFields: false,
}

/**
 * Notion resource ids are 32 lowercase hex digits (the URL form, e.g.
 * `4e123...`) or a dashed UUID (`xxxxxxxx-xxxx-...`). Accept both so a
 * legitimate id in either form is never rejected; reject anything that is not
 * hex/UUID-shaped (the malformed or injected value a prompt-injection would try
 * to smuggle past an advisory `format`).
 */
const UUID_PATTERN =
  '^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
/** Dashed-UUID length; an upper bound any real id satisfies. */
const ID_MAX_LENGTH = 36
/**
 * Generous ceiling for free-text fields (~100 KiB). Bounds unbounded payloads
 * while remaining far above any legitimate single field value.
 */
const FREE_TEXT_MAX_LENGTH = 100000

function isIdKey(key: string | undefined): boolean {
  if (!key) return false
  return key === 'id' || key.endsWith('_id') || key.endsWith('Id')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Load the schema-hardening policy from the `NOTION_SCHEMA_HARDENING` env var.
 *
 * Accepts the bare values `1`/`true` (enable both rules) or a JSON object to
 * toggle rules individually (`{"enabled":true,"boundStringFields":false}`).
 * Anything unparseable falls back to the disabled default with a warning, so a
 * malformed env var can never accidentally enable hardening. Mirrors the
 * `loadWriteGatePolicy` contract.
 */
export function loadSchemaHardeningPolicy(env: NodeJS.ProcessEnv = process.env): SchemaHardeningPolicy {
  const raw = env.NOTION_SCHEMA_HARDENING
  if (!raw || raw.trim() === '') {
    return { ...DISABLED_POLICY }
  }

  const trimmed = raw.trim()
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return { enabled: true, tightenIdFormat: true, boundStringFields: true }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) {
      console.warn('NOTION_SCHEMA_HARDENING must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    const enabled = parsed.enabled === true || parsed.enabled === 'true'
    // When the master switch is on, each rule defaults on unless explicitly false.
    return {
      enabled,
      tightenIdFormat: enabled && parsed.tightenIdFormat !== false,
      boundStringFields: enabled && parsed.boundStringFields !== false,
    }
  } catch (error) {
    console.warn('Failed to parse NOTION_SCHEMA_HARDENING environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

/**
 * Harden a leaf string schema in place (operating on a clone — see below).
 *
 * - id-shaped: add a UUID `pattern` + length cap unless one is already set.
 * - otherwise free-text: add a generous `maxLength` unless the field already
 *   carries any constraint (pattern/format/enum/const/maxLength), and skip the
 *   synthetic bare `{ type: 'string' }` branch `withStringFallback` emits for
 *   complex params that may arrive JSON-encoded as a string.
 */
function hardenStringInPlace(schema: Record<string, unknown>, key: string | undefined, policy: SchemaHardeningPolicy): void {
  const isUuid = schema.format === 'uuid'
  if (policy.tightenIdFormat && (isUuid || isIdKey(key)) && schema.pattern === undefined) {
    schema.pattern = UUID_PATTERN
    if (schema.maxLength === undefined) {
      schema.maxLength = ID_MAX_LENGTH
    }
    return
  }

  if (!policy.boundStringFields) return
  const hasConstraint =
    schema.pattern !== undefined ||
    schema.format !== undefined ||
    schema.enum !== undefined ||
    schema.const !== undefined ||
    schema.maxLength !== undefined
  const isBareFallback = Object.keys(schema).length === 1 && schema.type === 'string'
  if (!isBareFallback && !hasConstraint) {
    schema.maxLength = FREE_TEXT_MAX_LENGTH
  }
}

/**
 * Recursively walk a JSON Schema clone and tighten it in place.
 *
 * Carries each property's name down so id-shaped fields are detected by key, and
 * recurses through object `properties`, `$defs` (where Notion nests ids inside
 * referenced parent objects), array `items`, `additionalProperties`, and the
 * `oneOf`/`anyOf`/`allOf` combinators. `$ref` nodes are left as-is — the def
 * they point at is tightened directly inside `$defs`.
 */
function hardenInPlace(node: unknown, key: string | undefined, policy: SchemaHardeningPolicy): void {
  if (!isRecord(node)) return
  if ('$ref' in node) return

  if (node.type === 'string') {
    hardenStringInPlace(node, key, policy)
  }

  const props = node.properties
  if (isRecord(props)) {
    for (const [childKey, child] of Object.entries(props)) {
      hardenInPlace(child, childKey, policy)
    }
  }

  const defs = node['$defs']
  if (isRecord(defs)) {
    for (const def of Object.values(defs)) {
      hardenInPlace(def, undefined, policy)
    }
  }

  const items = node.items
  if (Array.isArray(items)) {
    for (const item of items) hardenInPlace(item, undefined, policy)
  } else if (isRecord(items)) {
    hardenInPlace(items, undefined, policy)
  }

  if (isRecord(node.additionalProperties)) {
    hardenInPlace(node.additionalProperties, undefined, policy)
  }

  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = node[combinator]
    if (Array.isArray(branches)) {
      for (const branch of branches) hardenInPlace(branch, key, policy)
    }
  }
}

/**
 * Tighten a tool's `inputSchema` according to the policy.
 *
 * Pure: returns the input unchanged when the policy is disabled, otherwise
 * returns a deep clone with the hardening applied (the converter caches schemas,
 * so the transform never mutates shared state). The top-level `type: 'object'`
 * is preserved.
 */
export function tightenInputSchema(
  schema: IJsonSchema & { type: 'object' },
  policy: SchemaHardeningPolicy,
): IJsonSchema & { type: 'object' } {
  if (!policy.enabled) return schema
  const clone = structuredClone(schema) as IJsonSchema & { type: 'object' }
  hardenInPlace(clone, undefined, policy)
  return clone
}
