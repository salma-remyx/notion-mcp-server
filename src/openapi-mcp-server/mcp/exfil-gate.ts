import type { OpenAPIV3 } from 'openapi-types'

/**
 * Deterministic pre-execution exfiltration gate for the Notion MCP server.
 *
 * Adapted from "Trivial Trojans: How Minimal MCP Servers Enable Cross-Tool
 * Exfiltration of Sensitive Data" (arXiv:2507.19880).
 *
 * Core mechanism (kept at full fidelity): the paper shows an agent can be
 * tricked into smuggling attacker-controlled URLs through the parameters of an
 * otherwise-benign tool call — the URL rides inside free-text fields (page
 * content, comments, bookmark blocks), and a second tool later fetches it,
 * exfiltrating whatever sensitive data was placed alongside it. The defense here
 * inspects the same channel deterministically: before a call reaches the Notion
 * API, every URL found anywhere in the deserialized params is host-checked
 * against an allowlist, and a call carrying a non-allowlisted URL is denied
 * with a structured error instead of executed.
 *
 * Auxiliary components substituted for target-native equivalents (Mode 2):
 *   - The paper's deliverable is a proof-of-concept malicious MCP server plus a
 *     live cross-tool exfiltration chain against a financial dataset. That
 *     attack infrastructure is replaced by its defensive dual at this server's
 *     own pre-execution seam (beside the write gate): a parameter-free URL
 *     allowlist check, no network calls, no second tool.
 *   - The paper's evaluation (manual attack walkthrough) is scoped out; this
 *     gate is verified by unit tests on the deterministic decision function.
 *
 * The gate is OFF by default (zero behavior change). Operators opt in via the
 * `NOTION_EXFIL_GATE` environment variable. See README for configuration.
 */

/** Policy the exfiltration gate is evaluated against. */
export type ExfilGatePolicy = {
  /** Master switch. When false every call is allowed (the default). */
  enabled: boolean
  /**
   * Allowlist of hostname suffixes URLs may point at. Matched as an exact
   * host match or a subdomain (`evil.notion.so` matches `notion.so`).
   * Defaults to Notion's own hosts when unset.
   */
  allowedUrlHosts?: string[]
}

export type ExfilGateDecision =
  | { allowed: true }
  | { allowed: false; gate: 'external-url'; reason: string }

/**
 * Hosts Notion content legitimately references: the workspace domains and the
 * file/attachment host Notion serves uploaded files from.
 */
const DEFAULT_ALLOWED_HOSTS = [
  'notion.so',
  'notion.com',
  'notion.site',
  'prod-files-secure.s3.us-west-2.amazonaws.com',
]

const DISABLED_POLICY: ExfilGatePolicy = { enabled: false }

// Bound the recursive param walk so adversarial input can't drive unbounded
// work. Real Notion payloads are far shallower than this.
const MAX_WALK_DEPTH = 12

// http(s) URLs, tolerant of the surrounding prose they're usually embedded in.
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/gi

/**
 * Load the exfiltration-gate policy from the `NOTION_EXFIL_GATE` environment
 * variable.
 *
 * Accepts a JSON object (the full policy) or the bare values `1`/`true` to
 * enable with the default host allowlist. Anything unparseable falls back to
 * the disabled default with a warning, so a malformed env var can never
 * accidentally enable the gate.
 */
export function loadExfilGatePolicy(env: NodeJS.ProcessEnv = process.env): ExfilGatePolicy {
  const raw = env.NOTION_EXFIL_GATE
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
      console.warn('NOTION_EXFIL_GATE must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_POLICY }
    }
    return normalizePolicy(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_EXFIL_GATE environment variable:', error)
    return { ...DISABLED_POLICY }
  }
}

function normalizePolicy(parsed: Record<string, unknown>): ExfilGatePolicy {
  const asStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    return value.filter((v): v is string => typeof v === 'string')
  }
  return {
    enabled: parsed.enabled === true || parsed.enabled === 'true',
    allowedUrlHosts: asStringArray(parsed.allowedUrlHosts),
  }
}

/**
 * Collect every http(s) URL embedded anywhere in the deserialized params —
 * top-level strings, prose inside rich_text content, bookmark/file block URLs,
 * and values nested in objects and arrays. This is the smuggling channel the
 * paper demonstrates: the URL lives in a field the Notion API happily accepts.
 */
export function extractParamUrls(value: unknown, depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH) {
    return []
  }

  if (typeof value === 'string') {
    return value.match(URL_PATTERN) ?? []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractParamUrls(item, depth + 1))
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((child) => extractParamUrls(child, depth + 1))
  }

  return []
}

/** Is `host` an exact match or a subdomain of an allowlisted suffix? */
function isAllowedHost(host: string, allowed: string[]): boolean {
  const normalized = host.toLowerCase()
  return allowed.some(
    (entry) => normalized === entry || normalized.endsWith(`.${entry}`),
  )
}

/**
 * Evaluate the exfiltration gate against a proposed call.
 *
 * Pure, deterministic, side-effect-free. Applies to reads and writes alike:
 * unlike the write gate, a URL smuggled into a search query or comment is just
 * as much an exfiltration channel as one in a page update, and the gate never
 * needs to reason about state transitions — only about where URLs point.
 */
export function evaluateExfilGate(
  _operation: OpenAPIV3.OperationObject & { method: string },
  params: Record<string, unknown>,
  policy: ExfilGatePolicy,
): ExfilGateDecision {
  if (!policy.enabled) {
    return { allowed: true }
  }

  const allowed = policy.allowedUrlHosts ?? DEFAULT_ALLOWED_HOSTS
  const offenders = new Set<string>()
  for (const url of extractParamUrls(params)) {
    let host: string | null = null
    try {
      host = new URL(url).hostname
    } catch {
      continue // regex matched something URL.parse rejects; nothing to check
    }
    if (host && !isAllowedHost(host, allowed)) {
      offenders.add(`${host} (${url})`)
    }
  }

  if (offenders.size > 0) {
    return {
      allowed: false,
      gate: 'external-url',
      reason: `params contain URL(s) pointing at non-allowlisted host(s): ${[...offenders].join(', ')}`,
    }
  }

  return { allowed: true }
}
