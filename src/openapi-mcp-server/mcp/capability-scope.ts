import type { OpenAPIV3 } from 'openapi-types'
import { isReadOperation } from './write-gate'

/**
 * Dynamic least-privilege capability scoping for the Notion MCP server.
 *
 * Adapted from "Dynamic Capability Scoping for Enterprise AI Agents: A
 * Synthetic Dataset and Three-Source Permission Architecture"
 * (arXiv:2607.22445).
 *
 * Core mechanism (kept at full fidelity): capability scoping is a
 * *prevention* mechanism evaluated *before* an operation reaches the Notion
 * API — "a credential that does not exist in an agent's context cannot be
 * misused regardless of the agent's reasoning or evasion sophistication." Each
 * per-request token otherwise unlocks the full ~24-tool surface; this gate
 * computes, per call, the narrowest scope the task actually needs and denies
 * (or, in observe-only mode, records) any operation outside it.
 *
 * The paper instantiates this with a *three-source* architecture. This gate
 * implements sources #1 and #2 and combines them at the most-restrictive
 * bound (the layered defense):
 *
 *   - Source #1 — role-based ceiling: a credential carries a max permission
 *     tier. Operations above the ceiling are out of scope.
 *   - Source #2 — task-context classifier: given a task description, a
 *     classifier derives the maximum tier the task requires; the effective
 *     scope is the *minimum* of the role ceiling and the task-required tier,
 *     so an agent holding a powerful credential still cannot exceed what its
 *     current task needs.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's 15-permission tool taxonomy is reduced to a Notion-native
 *     four-tier taxonomy (`read < comment < write < destructive`) derived
 *     from `operationId` + HTTP method.
 *   - The paper's learned task-context classifier is replaced by a
 *     parameter-free keyword heuristic over operator-supplied task text.
 *   - Source #3 — policy-derived *combination* prohibitions — is intentionally
 *     scoped out: it forbids sequences of operations (e.g. export→delete)
 *     within a session, which requires call-history state the MCP server does
 *     not host (each CallTool is evaluated statelessly). Adding session memory
 *     is the prerequisite for a faithful source #3.
 *   - The paper's synthetic dataset, eval framework, and observe-only
 *     telemetry pipeline are cut — evaluation belongs in a downstream PR.
 *
 * The paper supports both *enforcing* and *observe-only* deployment. This gate
 * implements both: `enforce: true` denies out-of-scope calls (prevention);
 * `enforce: false` lets them through while recording the mismatch as a
 * behavioral signal (the paper's observe-only mode for misalignment research).
 *
 * The gate is OFF by default (zero behavior change). Operators opt in via the
 * `NOTION_CAPABILITY_SCOPE` environment variable. See README for configuration.
 * It composes with — and runs after — the deterministic write-gate in
 * `write-gate.ts`; the write-gate handles specific deny-lists and target
 * allowlists on writes, while this gate handles tier-based scoping across all
 * operations.
 */

/**
 * Notion-native permission taxonomy. Ordered least- to most-privileged; the
 * rank drives every ceiling/intersection decision so the order is the contract.
 *
 *   read        — never mutates state (GET, plus the read `POST`s `post-search`
 *                 and `query-data-source`).
 *   comment     — creates/modifies a discussion thread without editing page
 *                 content (`create-a-comment`).
 *   write       — mutates content/structure (`post-page`, `patch-page`,
 *                 `move-page`, `update-a-block`, ...).
 *   destructive — irreversibly removes state (`delete-a-block`, and any future
 *                 `archive`/`trash` operation).
 */
export type PermissionTier = 'read' | 'comment' | 'write' | 'destructive'

const TIER_RANK: Record<PermissionTier, number> = {
  read: 0,
  comment: 1,
  write: 2,
  destructive: 3,
}

function isPermissionTier(value: unknown): value is PermissionTier {
  return value === 'read' || value === 'comment' || value === 'write' || value === 'destructive'
}

/** operationId fragments that signal an irreversible state removal. */
const DESTRUCTIVE_ID = /\b(archive|delete|trash|purge|destroy|wipe|remove)\b/

/**
 * Classify a proposed call into a permission tier. Deterministic and
 * side-effect-free. Reuses `isReadOperation` from the write-gate so the read
 * classification (GET + the non-GET query endpoints) can never drift between
 * the two gates — a read mislabelled as a write here would be a regression.
 */
export function classifyOperationTier(operation: {
  method?: string
  operationId?: string
}): PermissionTier {
  const id = (operation.operationId ?? '').toLowerCase()
  const method = (operation.method ?? '').toLowerCase()

  if (method === 'delete' || DESTRUCTIVE_ID.test(id)) {
    return 'destructive'
  }
  // A read is a read regardless of noun: `retrieve-a-comment` is GET, so it
  // costs only read privilege — classify reads before the comment keyword.
  if (isReadOperation(operation)) {
    return 'read'
  }
  if (/\bcomment\b/.test(id)) {
    return 'comment'
  }
  return 'write'
}

/**
 * Task-context classifier (Source #2) — Mode 2 substitution for the paper's
 * learned classifier. Parameter-free keyword heuristic: returns the *maximum*
 * tier implied by the task description, defaulting to `read` (least privilege)
 * when nothing stronger is asked for. "Read the meeting notes" → read;
 * "update the roadmap" → write; "archive old pages" → destructive.
 */
export function classifyTaskTier(taskContext: string): PermissionTier {
  const text = taskContext.toLowerCase()
  let tier: PermissionTier = 'read'
  if (/\b(comment|reply|mention|react)\b/.test(text) && TIER_RANK['comment'] > TIER_RANK[tier]) {
    tier = 'comment'
  }
  if (
    /\b(update|create|edit|modify|add|move|publish|share|assign|change|write|rename|replace|insert|restore|reorder|reorganiz|set up|organize)\b/.test(text) &&
    TIER_RANK['write'] > TIER_RANK[tier]
  ) {
    tier = 'write'
  }
  if (/\b(archive|delete|trash|purge|permanently|destroy|wipe|remove)\b/.test(text)) {
    tier = 'destructive'
  }
  return tier
}

/** Policy the capability-scope gate is evaluated against. */
export type CapabilityScopePolicy = {
  /** Master switch. When false every call is allowed (the default). */
  enabled: boolean
  /**
   * `true` (default) — enforce: deny out-of-scope calls pre-execution
   * (prevention). `false` — observe-only: let the call through but record the
   * mismatch as a behavioral signal (the paper's observe-only deployment).
   */
  enforce?: boolean
  /** Source #1 — role-based ceiling. Operations above this tier are denied. */
  roleCeiling?: PermissionTier
  /**
   * Source #2 — task-context classifier input (free text). When set, the
   * classifier derives the max tier the task requires and the effective
   * ceiling is the minimum of the role ceiling and the task-required tier.
   */
  taskContext?: string
}

export type ScopeSource = 'role-ceiling' | 'task-context'

export type ScopeDecision = {
  allowed: boolean
  /**
   * Present only in observe-only mode when the call is out of scope: the call
   * is allowed through but the mismatch was recorded. Lets callers/tests tell
   * a clean allow apart from an observed one.
   */
  observed?: boolean
  /** Which source bound the call (the most-restrictive one). */
  source?: ScopeSource
  reason?: string
  opTier?: PermissionTier
  ceiling?: PermissionTier
}

const DISABLED_POLICY: CapabilityScopePolicy = { enabled: false }

/**
 * Load the capability-scope policy from the `NOTION_CAPABILITY_SCOPE`
 * environment variable.
 *
 * Accepts a JSON object (the full policy) or the bare values `1`/`true` to
 * enable with enforcing mode and no sources (a no-op until a source is added).
 * Anything unparseable falls back to the disabled default with a warning, so a
 * malformed env var can never accidentally widen an agent's scope.
 */
export function loadCapabilityScopePolicy(env: NodeJS.ProcessEnv = process.env): CapabilityScopePolicy {
  const raw = env.NOTION_CAPABILITY_SCOPE
  if (!raw || raw.trim() === '') {
    return { ...DISABLED_POLICY }
  }

  const trimmed = raw.trim()
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return { enabled: true, enforce: true }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('NOTION_CAPABILITY_SCOPE must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    return normalizeScopePolicy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_CAPABILITY_SCOPE environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

function normalizeScopePolicy(parsed: Record<string, unknown>): CapabilityScopePolicy {
  const roleCeilingRaw = parsed.roleCeiling
  return {
    enabled: parsed.enabled === true || parsed.enabled === 'true',
    // Default to enforcing (prevention); observe-only is the explicit opt-in.
    enforce: parsed.enforce === false ? false : true,
    roleCeiling: isPermissionTier(roleCeilingRaw) ? roleCeilingRaw : undefined,
    taskContext: typeof parsed.taskContext === 'string' ? parsed.taskContext : undefined,
  }
}

/**
 * Evaluate the capability-scope gate against a proposed call.
 *
 * Pure, deterministic, side-effect-free. Computes the effective ceiling as the
 * most-restrictive bound across the configured sources and compares the
 * operation's tier to it. With neither source configured the gate is a no-op
 * (allow) — operators must opt into at least one source for scoping to bind.
 */
export function evaluateCapabilityScope(
  operation: OpenAPIV3.OperationObject & { method: string },
  _params: Record<string, unknown>,
  policy: CapabilityScopePolicy,
): ScopeDecision {
  if (!policy.enabled) {
    return { allowed: true }
  }

  const opTier = classifyOperationTier(operation)

  // Effective ceiling = most-restrictive of the configured sources. The paper's
  // layered defense: each source can only ever *narrow* the scope, never widen it.
  let ceiling: PermissionTier | undefined
  let bindingSource: ScopeSource | undefined

  if (policy.roleCeiling) {
    ceiling = policy.roleCeiling
    bindingSource = 'role-ceiling'
  }
  const taskContext = policy.taskContext?.trim()
  if (taskContext) {
    const taskTier = classifyTaskTier(taskContext)
    if (ceiling === undefined || TIER_RANK[taskTier] < TIER_RANK[ceiling]) {
      ceiling = taskTier
      bindingSource = 'task-context'
    }
  }

  // No source configured → nothing to scope → allow.
  if (ceiling === undefined || bindingSource === undefined) {
    return { allowed: true }
  }

  if (TIER_RANK[opTier] <= TIER_RANK[ceiling]) {
    return { allowed: true }
  }

  const reason = `operation tier '${opTier}' exceeds ${bindingSource} ceiling '${ceiling}'`

  // Observe-only: the credential exists and the call proceeds, but the mismatch
  // is recorded as a behavioral signal (paper's observe-only deployment).
  if (policy.enforce === false) {
    return { allowed: true, observed: true, source: bindingSource, reason, opTier, ceiling }
  }

  return { allowed: false, source: bindingSource, reason, opTier, ceiling }
}
