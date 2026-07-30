import type { OpenAPIV3 } from 'openapi-types'
import { isReadOperation } from './write-gate'

/**
 * State-aware pre-execution gate — the "read the world before a write" half of
 * the deterministic gate suite for the Notion MCP server.
 *
 * This is the distinct call-site scope the parameter-free {@link ./write-gate.ts}
 * explicitly deferred. That gate inspects only the *proposed call*; it cannot
 * see whether the target's current state already forbids the transition. This
 * gate adds the action-boundary round-trip: it fetches the target resource's
 * CURRENT state and inspects the proposed write against it before any write
 * reaches the Notion API.
 *
 * Adapted from "Reason Less, Verify More: Deterministic Gates Recover a Silent
 * Policy-Violation Failure Mode in Tool-Using LLM Agents" (arXiv:2607.07405),
 * which studies policy-permissive tools that execute any well-formed call even
 * when the corresponding state transition is forbidden — a silent wrong state
 * (a booking cancelled, a passenger count changed) that neither the tool nor the
 * agent exposes. The intervention is deterministic, read-only pre-execution
 * gates that inspect the proposed call AND current state before allowing a write.
 *
 * Core mechanism kept at full fidelity (Mode 2 — adapted port): a deterministic,
 * read-only pre-execution check that reads the target's current state and denies
 * writes whose state transition is forbidden by policy.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's airline-domain state predicates (a booking already cancelled,
 *     a passenger count already changed) are replaced by a Notion-native
 *     predicate: the target resource's `archived` flag. This is the direct
 *     Notion analog of "acting on an already-cancelled booking" — writing to an
 *     archived (trashed) resource is a silent wrong state the agent never sees.
 *   - The paper's benchmark / eval framework is cut — evaluation belongs in a
 *     downstream PR.
 *
 * Like the parameter-free gate this is OFF by default (zero behavior change).
 * Operators opt in via the `NOTION_STATE_GATE` environment variable. The
 * round-trip runs only for writes (reads short-circuit) and only when an
 * operator opts in, so the default path pays no extra API call.
 */

/** Policy the state-aware gate is evaluated against. */
export type StateAwareGatePolicy = {
  /** Master switch. When false every call is allowed (the default). */
  enabled: boolean
  /**
   * Deny a write whose target resource is currently archived. Defaults to true
   * whenever the gate is enabled (the archived guard is the gate's purpose); an
   * operator who wants only the plumbing can set it explicitly to false.
   */
  denyWritesToArchived?: boolean
}

export type GateStateDecision =
  | { allowed: true }
  | { allowed: false; gate: string; reason: string }

/**
 * Normalized current state of the target a write is about to touch. Only the
 * fields a predicate inspects are pulled out, so the round-trip response shape
 * can evolve without touching the decision logic.
 */
export type TargetState = {
  archived?: boolean
}

/** Write target id key → operationId of the read that fetches its state. */
const STATE_READ_OPERATION: Record<string, string> = {
  page_id: 'retrieve-a-page',
  block_id: 'retrieve-a-block',
  database_id: 'retrieve-a-database',
  data_source_id: 'retrieve-a-data-source',
  comment_id: 'retrieve-a-comment',
}

const DISABLED_POLICY: StateAwareGatePolicy = { enabled: false }

/**
 * Resolve the read-only round-trip that fetches a write target's current state.
 *
 * Matches only the *direct* target id a write mutates (top-level `page_id`,
 * `block_id`, ...). This covers the primary write operations (`patch-page`,
 * `update-page-markdown`, `update-a-block`, `update-a-data-source`, ...) whose
 * state the archived guard meaningfully checks. Container-shaped writes
 * (`create-a-page` under a `parent`) are intentionally out of scope — reading
 * the parent's archived flag is a weaker signal and is left to a later gate.
 *
 * Returns null when no inspectable target is present; callers fail open.
 */
export function resolveStateRead(
  params: Record<string, unknown>,
): { paramKey: string; operationId: string; targetId: string } | null {
  for (const [key, value] of Object.entries(params)) {
    const operationId = STATE_READ_OPERATION[key]
    if (operationId && typeof value === 'string' && value.length > 0) {
      return { paramKey: key, operationId, targetId: value }
    }
  }
  return null
}

/**
 * Pull the predicate-relevant fields out of a retrieve response. Anything that
 * isn't a recognized state field is dropped, so an unexpected response shape
 * yields an empty state and the gate fails open.
 */
export function normalizeTargetState(raw: unknown): TargetState {
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>
    if (typeof obj.archived === 'boolean') {
      return { archived: obj.archived }
    }
  }
  return {}
}

/**
 * Load the state-aware gate policy from the `NOTION_STATE_GATE` env var.
 *
 * Accepts a JSON object (the full policy) or the bare values `1`/`true` to
 * enable with the default predicate (`denyWritesToArchived`). Anything
 * unparseable falls back to the disabled default with a warning, so a malformed
 * env var can never accidentally enable the gate.
 */
export function loadStateAwareGatePolicy(env: NodeJS.ProcessEnv = process.env): StateAwareGatePolicy {
  const raw = env.NOTION_STATE_GATE
  if (!raw || raw.trim() === '') {
    return { ...DISABLED_POLICY }
  }

  const trimmed = raw.trim()
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return { enabled: true, denyWritesToArchived: true }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('NOTION_STATE_GATE must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    return normalizePolicy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_STATE_GATE environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

function normalizePolicy(parsed: Record<string, unknown>): StateAwareGatePolicy {
  const enabled = parsed.enabled === true || parsed.enabled === 'true'
  // `denyWritesToArchived` defaults to true when the gate is on and the operator
  // hasn't said otherwise — the archived guard is the gate's reason to exist.
  // An explicit value (true/false) always wins.
  const explicit = parsed.denyWritesToArchived
  return {
    enabled,
    denyWritesToArchived: explicit === undefined ? enabled : explicit === true,
  }
}

/**
 * Evaluate the state-aware gate against a proposed write and its target's
 * CURRENT state.
 *
 * Pure, deterministic, side-effect-free. Reads always pass (see
 * {@link isReadOperation}); only writes are gated, mirroring the parameter-free
 * gate and the paper's negative-control result (gates stay out of the way of
 * calls that don't mutate state). An empty/unknown state fails open.
 */
export function evaluateStateAwareGate(
  operation: OpenAPIV3.OperationObject & { method?: string },
  params: Record<string, unknown>,
  policy: StateAwareGatePolicy,
  state: TargetState,
): GateStateDecision {
  if (!policy.enabled) {
    return { allowed: true }
  }

  if (isReadOperation(operation)) {
    return { allowed: true }
  }

  if (policy.denyWritesToArchived && state.archived === true) {
    const read = resolveStateRead(params)
    return {
      allowed: false,
      gate: 'state-archived-target',
      reason: `write target '${read?.targetId ?? ''}' is archived; policy forbids writes to archived resources`,
    }
  }

  return { allowed: true }
}

/**
 * Capabilities the host injects so the gate can "read the world" without the
 * module depending on the HTTP client or the OpenAPI lookup table.
 */
export type StateGateDeps = {
  /**
   * Resolve the read operation that fetches a target's state, by operationId.
   * Return null when the read operation isn't registered.
   */
  resolveReadOperation: (operationId: string) => unknown
  /**
   * Execute a read-only operation and return its response body. Throwing here
   * makes the gate fail open rather than block the write.
   */
  readState: (operation: unknown, params: Record<string, unknown>) => Promise<unknown>
}

/**
 * Orchestrate the "read the world before a write" round-trip and evaluate the
 * proposed write against the fetched current state. The pure policy/state logic
 * lives in {@link evaluateStateAwareGate}; this function wires the I/O the host
 * injects. Disabled policy, unresolvable reads, missing read operations, and
 * read errors all fail open, so the round-trip never blocks a legitimate write
 * on its own account.
 */
export async function runStateAwareGate(
  operation: OpenAPIV3.OperationObject & { method?: string },
  params: Record<string, unknown>,
  policy: StateAwareGatePolicy,
  deps: StateGateDeps,
): Promise<GateStateDecision> {
  if (!policy.enabled) {
    return { allowed: true }
  }

  const stateRead = resolveStateRead(params)
  if (!stateRead) {
    return { allowed: true }
  }

  const readOp = deps.resolveReadOperation(stateRead.operationId)
  if (!readOp) {
    return { allowed: true }
  }

  let state
  try {
    state = normalizeTargetState(
      await deps.readState(readOp, { [stateRead.paramKey]: stateRead.targetId }),
    )
  } catch (error) {
    console.warn('State-aware gate could not read target state; failing open', {
      operationId: operation.operationId,
      targetId: stateRead.targetId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return { allowed: true }
  }

  return evaluateStateAwareGate(operation, params, policy, state)
}
