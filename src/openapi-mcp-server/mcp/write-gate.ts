import type { OpenAPIV3 } from 'openapi-types'

/**
 * Deterministic pre-execution write gates for the Notion MCP server.
 *
 * Adapted from "Reason Less, Verify More: Deterministic Gates Recover a Silent
 * Policy-Violation Failure Mode in Tool-Using LLM Agents" (arXiv:2607.07405).
 *
 * Core mechanism (kept at full fidelity): before a write reaches the Notion API,
 * a set of deterministic, read-only gates inspects the proposed call (operation
 * + deserialized params) against an operator-defined policy and DENIES calls
 * whose state transition is forbidden — even when the call is well-formed and
 * the Notion API would otherwise happily execute it. This is exactly the
 * "silent wrong state" failure mode the paper studies: a tool executes a
 * policy-violating write with no tool error, and neither the tool nor the
 * agent's self-report surfaces it.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's four-gate suite is specific to its airline booking domain.
 *     The gates here are the Notion-native analog: a denied-operation gate and
 *     a write-target allowlist gate.
 *   - The paper's "current state" inspection (read the world before a write) is
 *     intentionally scoped out — it needs live Notion reads at the action
 *     boundary. These gates are parameter-free and inspect only the proposed
 *     call, so they stay deterministic and side-effect-free with no round-trip.
 *
 * The gate is OFF by default (zero behavior change). Operators opt in via the
 * `NOTION_WRITE_GATE` environment variable. See README for configuration.
 */

/** Policy the write-gate suite is evaluated against. */
export type WriteGatePolicy = {
  /** Master switch. When false every call is allowed (the default). */
  enabled: boolean
  /**
   * `operationId` values to deny outright as policy-forbidden writes
   * (e.g. `archive-a-page`, `delete-a-block`). Matched case-insensitively.
   */
  deniedOperations?: string[]
  /**
   * Allowlist of target resource IDs (page/block/database/data-source/comment).
   * When non-empty, a write whose target id is missing from this set is denied.
   * Undefined or empty → no allowlist enforced.
   */
  allowedTargetIds?: string[]
}

export type GateDecision =
  | { allowed: true }
  | { allowed: false; gate: string; reason: string }

/** Property names that carry the resource a write targets. */
const TARGET_ID_KEYS = [
  'page_id',
  'block_id',
  'database_id',
  'data_source_id',
  'comment_id',
  'user_id',
]

/**
 * Operation ids that are reads despite using a non-`GET` verb. Notion models a
 * few query endpoints as `POST` (they carry a request body) even though they
 * never mutate state — e.g. `query-data-source` is `POST
 * /v1/data_sources/{data_source_id}/query`, a read that carries a
 * `data_source_id`. Verb-derived tool annotations mislabel these as destructive
 * (makenotion/notion-mcp-server#333). The gate must never deny a read, so these
 * are classified as reads regardless of method or the target id they carry.
 */
const READ_OPERATION_IDS = new Set(['post-search', 'query-data-source'])

const DISABLED_POLICY: WriteGatePolicy = { enabled: false }

/**
 * Deterministically classify a proposed call as a read.
 *
 * Reads are never gated: the paper's failure mode is a policy-violating *write*
 * (a forbidden state transition), and its negative-control result shows gates
 * should stay out of the way of calls that don't mutate state. A read misfiring
 * as a write — e.g. an allowlist denying a legitimate `query-data-source` on a
 * data source outside the list — is exactly the regression this guards against.
 */
export function isReadOperation(operation: { method?: string; operationId?: string }): boolean {
  if (operation.method?.toLowerCase() === 'get') {
    return true
  }
  return operation.operationId ? READ_OPERATION_IDS.has(operation.operationId.toLowerCase()) : false
}

/**
 * Load the write-gate policy from the `NOTION_WRITE_GATE` environment variable.
 *
 * Accepts a JSON object (the full policy) or the bare values `1`/`true` to
 * enable with no rules. Anything unparseable falls back to the disabled default
 * with a warning, so a malformed env var can never accidentally enable the gate.
 */
export function loadWriteGatePolicy(env: NodeJS.ProcessEnv = process.env): WriteGatePolicy {
  const raw = env.NOTION_WRITE_GATE
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
      console.warn('NOTION_WRITE_GATE must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    return normalizePolicy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_WRITE_GATE environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

function normalizePolicy(parsed: Record<string, unknown>): WriteGatePolicy {
  const asStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    return value.filter((v): v is string => typeof v === 'string')
  }
  return {
    enabled: parsed.enabled === true || parsed.enabled === 'true',
    deniedOperations: asStringArray(parsed.deniedOperations),
    allowedTargetIds: asStringArray(parsed.allowedTargetIds),
  }
}

/**
 * Pull the resource id(s) a write targets out of the deserialized params.
 *
 * Covers top-level ids (`page_id`, `block_id`, ...) and one level of nesting
 * for the container shapes Notion create/move operations use
 * (`parent.page_id`, `parent.database_id`, `new_parent.page_id`).
 */
function extractTargetIds(params: Record<string, unknown>): string[] {
  const ids: string[] = []
  const collectFrom = (value: Record<string, unknown>) => {
    for (const [key, child] of Object.entries(value)) {
      if (TARGET_ID_KEYS.includes(key) && typeof child === 'string' && child.length > 0) {
        ids.push(child)
      }
    }
  }

  collectFrom(params)
  for (const value of Object.values(params)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectFrom(value as Record<string, unknown>)
    }
  }
  return ids
}

/**
 * Evaluate the write-gate suite against a proposed call.
 *
 * Pure, deterministic, side-effect-free. Reads are always allowed (see
 * `isReadOperation` — `GET` plus the non-`GET` query endpoints); only writes are
 * gated, since the paper's policy-violating-write failure mode applies only to
 * calls that mutate state.
 */
export function evaluateWriteGate(
  operation: OpenAPIV3.OperationObject & { method: string },
  params: Record<string, unknown>,
  policy: WriteGatePolicy,
): GateDecision {
  if (!policy.enabled) {
    return { allowed: true }
  }

  if (isReadOperation(operation)) {
    return { allowed: true }
  }

  // Gate 1 — deny-listed operations.
  const operationId = operation.operationId
  const denied = policy.deniedOperations ?? []
  if (operationId && denied.some((op) => op.toLowerCase() === operationId.toLowerCase())) {
    return {
      allowed: false,
      gate: 'denied-operation',
      reason: `operation '${operationId}' is on the denied list`,
    }
  }

  // Gate 2 — write-target allowlist. Fires only when an allowlist is configured
  // AND the call carries an inspectable target id; otherwise it fails open.
  const allow = policy.allowedTargetIds
  if (allow && allow.length > 0) {
    const allowSet = new Set(allow)
    const outOfPolicy = extractTargetIds(params).filter((id) => !allowSet.has(id))
    if (outOfPolicy.length > 0) {
      return {
        allowed: false,
        gate: 'target-allowlist',
        reason: `write target(s) not on allowlist: ${outOfPolicy.join(', ')}`,
      }
    }
  }

  return { allowed: true }
}
