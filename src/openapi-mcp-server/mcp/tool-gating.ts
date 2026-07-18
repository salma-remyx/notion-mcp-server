/**
 * Tool gating + lazy schema loading — adapted from "Tool Attention Is All You
 * Need: Dynamic Tool Gating and Lazy Schema Loading for Eliminating the MCP/
 * Tools Tax in Scalable Agentic Workflows" (arXiv:2604.21816v1).
 *
 * By default this server eagerly emits every OpenAPI-derived tool with its full
 * description and input schema on every `tools/list` response — the per-turn
 * token payload the paper calls the "MCP Tax" (reported at ~10k–60k tokens in
 * multi-server deployments). This module applies two parameter-free proxies for
 * the paper's two mechanisms:
 *
 *   1. Dynamic tool gating — the paper *learns* a "Tool Attention" module that
 *      scores which tools are relevant per turn. That learned estimator is an
 *      auxiliary component this server has no trainer to host, so we substitute a
 *      deterministic scorer keyed on operation metadata the server already holds:
 *      the HTTP method (read-only gate), the OpenAPI path (resource-category
 *      gate), or an explicit operation-name allowlist. Same gating behaviour,
 *      no learned weights.
 *   2. Lazy schema loading — the paper defers a tool's full schema until the
 *      turn that actually calls it. The standard MCP `tools/list` → `tools/call`
 *      contract requires `inputSchema` to be present at list time, so a tool's
 *      schema cannot be dropped without a custom fetch-schema RPC. We instead
 *      defer the verbose *description* payload — each tool's multi-line
 *      description appends a per-tool "Error Responses" block (see parser.ts),
 *      and lazy mode collapses it to the operation's one-line summary at list
 *      time. That is the same per-turn payload reduction, delivered within the
 *      existing contract.
 *
 * Intentionally out of scope (Mode 2 substitutions): the learned Tool Attention
 * model and its training procedure, and the paper's evaluation/benchmark suite
 * (evaluation belongs in a downstream PR).
 */

/** How the exposed tool set is filtered on each `tools/list` response. */
export type ToolGatingMode = 'off' | 'read-only' | 'category' | 'names'

export interface ToolGatingOptions {
  /**
   * Gating strategy. `'off'` (default) preserves the legacy behaviour of
   * exposing every tool. The other modes drop tools that the gate rejects.
   */
  mode?: ToolGatingMode
  /** For `'category'` mode: only operations whose resource category is listed. */
  categories?: string[]
  /** For `'names'` mode: only operations whose (truncated) tool name is listed. */
  names?: string[]
  /** Lazy schema loading: collapse each tool's description to a one-line summary. */
  lazySchema?: boolean
}

/**
 * A tool together with the OpenAPI metadata the deterministic gates key on.
 * `inputSchema` is opaque here — gating never inspects it, only forwards it.
 */
export interface GatableTool {
  name: string
  description: string
  inputSchema: unknown
  method: string
  path: string
}

/**
 * Derive a coarse resource category from an OpenAPI path, e.g.
 * `/v1/pages/{page_id}` → `pages`, `/v1/blocks/{block_id}/children` → `blocks`.
 * This is the parameter-free signal the category gate scores on.
 */
export function deriveCategory(openApiPath: string): string {
  const segments = openApiPath
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    // Drop an API version prefix such as `v1`.
    .filter(segment => !/^v\d+$/i.test(segment))
  return segments[0] ?? ''
}

/**
 * First-line summary of a tool description, used to defer the verbose
 * description payload. The parser concatenates the operation summary with a
 * `\nError Responses:\n…` block per tool; this returns just the leading line.
 */
export function summarizeDescription(description: string): string {
  if (!description) {
    return description
  }
  const firstLine = description.split(/\r?\n/)[0] ?? ''
  return firstLine.trim()
}

function normalizeList(values?: string[]): string[] {
  return (values ?? [])
    .map(value => value.trim())
    .filter(value => value.length > 0)
}

/**
 * Parameter-free proxy for the paper's learned Tool Attention score: returns
 * whether a single tool survives the configured gate.
 */
function passesGate(tool: GatableTool, mode: ToolGatingMode, options: ToolGatingOptions): boolean {
  switch (mode) {
    case 'read-only':
      return tool.method.toLowerCase() === 'get'
    case 'category': {
      const wanted = normalizeList(options.categories)
      if (wanted.length === 0) {
        return true
      }
      return wanted.includes(deriveCategory(tool.path))
    }
    case 'names': {
      const wanted = normalizeList(options.names)
      if (wanted.length === 0) {
        return true
      }
      return wanted.includes(tool.name)
    }
    case 'off':
    default:
      return true
  }
}

/**
 * Decide whether a single tool is exposed this turn. Returns the tool to expose
 * (with its description collapsed to a one-line summary when `lazySchema` is on)
 * or `null` to drop it from the listing.
 */
export function selectTool(tool: GatableTool, options: ToolGatingOptions): GatableTool | null {
  const mode = options.mode ?? 'off'
  if (!passesGate(tool, mode, options)) {
    return null
  }
  if (options.lazySchema) {
    return { ...tool, description: summarizeDescription(tool.description) }
  }
  return tool
}

function parseMode(value: string | undefined): ToolGatingMode {
  if (!value) {
    return 'off'
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'read-only' || normalized === 'readonly') {
    return 'read-only'
  }
  if (normalized === 'category' || normalized === 'categories') {
    return 'category'
  }
  if (normalized === 'names' || normalized === 'name') {
    return 'names'
  }
  return 'off'
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * Resolve gating options from the environment, mirroring the repo's existing
 * operator-config convention (`OPENAPI_MCP_HEADERS` / `NOTION_TOKEN`). Every env
 * knob is optional; if none are set the effective mode is `'off'`, preserving
 * the legacy all-tools behaviour.
 *
 * Recognised variables:
 *   - `MCP_TOOL_GATING_MODE`        — one of off | read-only | category | names
 *   - `MCP_TOOL_GATING_CATEGORIES`  — comma-separated resource categories
 *   - `MCP_TOOL_GATING_NAMES`       — comma-separated tool names
 *   - `MCP_TOOL_GATING_LAZY_SCHEMA` — `1`/`true` enables description trimming
 */
export function gatingOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ToolGatingOptions {
  const lazySchemaEnv = env.MCP_TOOL_GATING_LAZY_SCHEMA
  return {
    mode: parseMode(env.MCP_TOOL_GATING_MODE),
    categories: splitCsv(env.MCP_TOOL_GATING_CATEGORIES),
    names: splitCsv(env.MCP_TOOL_GATING_NAMES),
    lazySchema: lazySchemaEnv === '1' || lazySchemaEnv === 'true',
  }
}
