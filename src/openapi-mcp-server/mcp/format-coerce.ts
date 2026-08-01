import { JSONSchema7 as IJsonSchema } from 'json-schema'

/**
 * Schema-aware repair of model arguments that violate the format instructions
 * embedded in parameter descriptions — the failure class measured by
 * IFEval-FC (arXiv:2509.18420v1, "Instruction-Following Evaluation in Function
 * Calling for Large Language Models"). Concretely it repairs three documented
 * violation categories, each only when the tool's own schema pins the target:
 *
 *   - wrong scalar type:  "42" against `{type:"integer"}`, "true" against
 *     `{type:"boolean"}`, "3.5" against `{type:"number"}`;
 *   - enum casing/whitespace drift: "active " against
 *     `{enum:["Active","Archived"]}` -> "Active";
 *   - non-ISO dates: "2024/03/15" against `{type:"string",format:"date"}` ->
 *     "2024-03-15" (and the date-time analogue), validated to round-trip.
 *
 * This is an ADAPTED PORT (Mode 2). The paper's contribution is a *benchmark*
 * that scores how often models break these embedded instructions; here that
 * same taxonomy becomes a deterministic, schema-anchored repair pass that runs
 * right after `deserializeParams` in MCPProxy, so a tool call survives a format
 * slip instead of round-tripping a 400. Intentionally out of scope: the paper's
 * benchmark suite, prompt-instruction classifier, and leaderboard — measuring
 * adherence is downstream of repairing it, and evaluation belongs in a separate
 * pass. Also out of scope: locale-ambiguous or natural-language date parsing
 * ("March 15, 2024") — only the unambiguous slash→dash repair is applied, and
 * only when the result parses to a real date.
 *
 * Conservative contract: a value is altered ONLY when a schema explicitly pins
 * a type / enum / format the value violates, and only via an exact match
 * (case- and whitespace-insensitive for enums). When no schema is supplied the
 * value is returned untouched — so the schema-agnostic "never corrupt a genuine
 * string" guarantee that `deserializeParams` already relies on (see
 * proxy.test.ts, "should not coerce scalar or quoted-scalar string params") is
 * preserved.
 */

/** Cap recursion through nested anyOf/oneOf so a pathological schema can't loop. */
const MAX_COMPOSITE_DEPTH = 8

/**
 * Coerce every property of `params` against the matching property schema. Used
 * at the top level (the tool's `inputSchema`) and recursively for nested
 * objects. Properties absent from the schema, and a missing schema entirely,
 * are passed through unchanged.
 */
export function coerceParamFormats(
  params: Record<string, unknown>,
  schema?: IJsonSchema,
): Record<string, unknown> {
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object') {
    return params
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    result[key] = key in properties ? coerceValue(value, asSchema(properties[key])) : value
  }
  return result
}

/**
 * Normalize a single value against its schema. Composite schemas (anyOf/oneOf,
 * which `withStringFallback` wraps complex/array params in) are expanded into
 * their concrete branches and the first branch that changes the value wins;
 * arrays recurse through `items`; objects recurse through `properties`; scalar
 * leaves are repaired by {@link coerceLeaf}.
 */
export function coerceValue(value: unknown, schema?: IJsonSchema): unknown {
  if (!schema) {
    return value
  }

  // Composite schema: try each concrete branch, keep the first that actually
  // changes the value. If none do, fall through to the field-level rules using
  // the composite itself (coerceLeaf will no-op on a composite).
  const branches = expandComposite(schema)
  if (branches) {
    for (const branch of branches) {
      const coerced = coerceValue(value, branch)
      if (coerced !== value) {
        return coerced
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    const items = asSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items)
    return items ? value.map((item) => coerceValue(item, items)) : value
  }

  if (typeof value === 'object' && value !== null) {
    return coerceParamFormats(value as Record<string, unknown>, schema)
  }

  return coerceLeaf(value, schema)
}

/**
 * If `schema` is an anyOf/oneOf, return its concrete (non-composite) branches
 * flattened with a depth bound; otherwise return `null` to signal that
 * `schema` is concrete and should be handled directly.
 */
function expandComposite(schema: IJsonSchema, depth = 0): IJsonSchema[] | null {
  if (depth > MAX_COMPOSITE_DEPTH) {
    return null
  }
  const composite = schema.anyOf ?? schema.oneOf
  if (!Array.isArray(composite)) {
    return null
  }
  const branches: IJsonSchema[] = []
  for (const def of composite) {
    const branch = asSchema(def)
    if (!branch) {
      continue
    }
    const nested = expandComposite(branch, depth + 1)
    if (nested) {
      branches.push(...nested)
    } else {
      branches.push(branch)
    }
  }
  return branches
}

/**
 * Narrow a JSON Schema definition to a concrete schema object. JSON Schema
 * permits `true` (accept anything) / `false` (reject) as a definition; neither
 * pins a type / format / enum, so they collapse to "no schema" (pass-through).
 */
function asSchema(def: unknown): IJsonSchema | undefined {
  return def !== null && typeof def === 'object' && !Array.isArray(def)
    ? (def as IJsonSchema)
    : undefined
}

/**
 * Repair a scalar leaf against a concrete schema's type / enum / format.
 * Returns the value unchanged whenever there is no single concrete type to
 * target or the value doesn't match the expected shape exactly.
 */
function coerceLeaf(value: unknown, schema: IJsonSchema): unknown {
  if (value === null || value === undefined) {
    return value
  }

  // Enum adherence: match a string value to a member, case- and
  // whitespace-insensitively, returning the member's canonical casing.
  if (typeof value === 'string' && Array.isArray(schema.enum)) {
    const lowered = value.trim().toLowerCase()
    for (const member of schema.enum) {
      if (typeof member === 'string' && member.trim().toLowerCase() === lowered) {
        return member
      }
    }
  }

  // Only single concrete types are repairable; unions like ["string","null"]
  // are left to the caller's existing validation.
  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (!type) {
    return value
  }

  if (typeof value !== 'string') {
    return value
  }

  switch (type) {
    case 'integer':
      if (/^[+-]?\d+$/.test(value.trim())) {
        const n = Number(value)
        if (Number.isSafeInteger(n)) {
          return n
        }
      }
      return value
    case 'number':
      if (DECIMAL_NUMBER.test(value.trim())) {
        const n = Number(value)
        if (Number.isFinite(n)) {
          return n
        }
      }
      return value
    case 'boolean': {
      const v = value.trim().toLowerCase()
      if (v === 'true') return true
      if (v === 'false') return false
      return value
    }
    case 'string':
      if (schema.format === 'date' || schema.format === 'date-time') {
        return coerceDateFormat(value, schema.format)
      }
      return value
    default:
      return value
  }
}

// Decimal numeric literal (no hex / Infinity / NaN), scientific notation allowed.
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Repair a `/`-separated date to ISO against a `date` / `date-time` field, but
 * only when the repaired string parses to a real date — no locale guessing.
 * Already-ISO values are returned untouched.
 */
function coerceDateFormat(value: string, format: 'date' | 'date-time'): string {
  if (format === 'date' && ISO_DATE.test(value)) {
    return value
  }
  if (format === 'date-time' && ISO_DATE_TIME.test(value)) {
    return value
  }
  // `YYYY/MM/DD[...]` -> `YYYY-MM-DD[...]`. The time portion of a date-time
  // uses `:` separators, so a global slash→dash swap is safe here.
  if (SLASH_DATE.test(value)) {
    const dashed = value.replace(/\//g, '-')
    if (!Number.isNaN(Date.parse(dashed))) {
      return dashed
    }
  }
  return value
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const SLASH_DATE = /^\d{4}\/\d{2}\/\d{2}/
