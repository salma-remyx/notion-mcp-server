import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'

/**
 * Canary probe tools for diagnosing LLM tool-selection weaknesses.
 *
 * Adapted from "Diagnosing Tool-Selection Reasoning in LLM Agents with Canary
 * Tools" (arXiv:2608.04719).
 *
 * Core mechanism (kept at full fidelity): diagnostic probe tools planted in the
 * agent's MCP tool set, each engineered to probe exactly one tool-selection
 * weakness from the paper's six-type taxonomy (semantic decoys, parameter traps,
 * capability mirages, prerequisite blindness, temporal decoys, granularity
 * traps). An agent that *invokes* a canary has been misled into selecting a tool
 * it should not have — that invocation is the paper's measurable signal (the
 * canary susceptibility rate, CSR). When a canary is invoked the server returns
 * a structured `status: "canary"` response instead of calling Notion, which both
 * tells the agent it picked a non-existent tool and makes the susceptibility
 * event observable to an evaluation harness (the raw per-call signal the paper's
 * judges would score).
 *
 * Auxiliary components substituted or cut (Mode 2 — adapted port):
 *   - The paper's evaluation harness (8 models × 120 tasks × 3 canary-density
 *     conditions × 3 seeds, plus a 2,880-run subtlety ablation, graded by two
 *     independent judges with Cohen's kappa = 0.75) is intentionally cut —
 *     evaluation belongs in a downstream PR. This module emits the per-call
 *     susceptibility event, not aggregate scores.
 *   - The provider-independent judge and CSR aggregation/statistics are not
 *     reproduced; the server surfaces the raw event for whatever scorer an
 *     operator wires up downstream.
 *   - The canary schemas are Notion-native analogs of the paper's generic probe
 *     set (a decoy that mimics a page-content tool, an export mirage, ...), so
 *     they sit naturally alongside the real Notion tools and probe the team's
 *     tool-annotation quality directly.
 *
 * The probes are OFF by default (zero behavior change — the real tool list and
 * every tool call are untouched). Operators opt in via the `NOTION_CANARY_TOOLS`
 * environment variable, mirroring the established `NOTION_WRITE_GATE` pattern.
 * See README for configuration.
 */

/** One slot of the paper's six-type tool-selection-weakness taxonomy. */
export type CanaryType =
  | 'semantic-decoy'
  | 'parameter-trap'
  | 'capability-mirage'
  | 'prerequisite-blindness'
  | 'temporal-decoy'
  | 'granularity-trap'

/** The full taxonomy, in the paper's order. */
export const ALL_CANARY_TYPES: CanaryType[] = [
  'semantic-decoy',
  'parameter-trap',
  'capability-mirage',
  'prerequisite-blindness',
  'temporal-decoy',
  'granularity-trap',
]

export type CanaryTool = {
  /** Taxonomy slot this probe targets. */
  type: CanaryType
  /** MCP tool definition exposed to the agent (looks like a real Notion tool). */
  tool: Tool
  /** Stable marker the diagnostic response carries so an eval can detect a hit. */
  marker: string
}

export type CanaryConfig = {
  /** Master switch. When false no canaries are injected (the default). */
  enabled: boolean
  /** Taxonomy types to inject. Undefined/empty → all six. */
  types?: CanaryType[]
}

const DISABLED_CONFIG: CanaryConfig = { enabled: false }

type CanarySeed = {
  type: CanaryType
  name: string
  title: string
  description: string
  inputSchema: IJsonSchema & { type: 'object' }
  readOnly: boolean
}

/**
 * The six Notion-native canaries, one per taxonomy slot. Each looks like a
 * plausible Notion operation but encodes one tool-selection weakness: a
 * non-existent resource ("document"), a parameter the real tool doesn't take
 * (full-text content search), a capability the API lacks (PDF export), a skipped
 * prerequisite (parent id), a non-existent temporal surface (point-in-time), or
 * the wrong granularity (unbounded list). Give-away phrases are kept mild so the
 * probe tests reasoning over the model's actual understanding of Notion rather
 * than phrase-spotting — the paper's subtlety ablation shows frontier models are
 * not moved by softening the phrase, which is why these stay fair at default.
 */
const CANARY_SEEDS: CanarySeed[] = [
  {
    type: 'semantic-decoy',
    name: 'retrieve-document-summary',
    title: 'Retrieve Document Summary',
    description:
      'Retrieve a concise summary of a Notion document by its id. Returns the document title and a generated summary of the document content.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'The id of the Notion document to summarize.' },
      },
      required: ['document_id'],
    },
    readOnly: true,
  },
  {
    type: 'parameter-trap',
    name: 'search-database-rows-by-content',
    title: 'Search Database Rows By Content',
    description:
      'Search every row inside a Notion database for matching text, running a full-text search across all property values. Provide a data_source_id and a content query.',
    inputSchema: {
      type: 'object',
      properties: {
        data_source_id: { type: 'string', description: 'The database/data source to search.' },
        content_query: { type: 'string', description: 'Free-text query to match against row content.' },
      },
      required: ['data_source_id', 'content_query'],
    },
    readOnly: true,
  },
  {
    type: 'capability-mirage',
    name: 'export-page-as-pdf',
    title: 'Export Page As PDF',
    description:
      'Export a Notion page as a downloadable PDF file, including all nested content and images, by page id.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page to export.' },
      },
      required: ['page_id'],
    },
    readOnly: true,
  },
  {
    type: 'prerequisite-blindness',
    name: 'append-block-to-page-by-title',
    title: 'Append Block To Page By Title',
    description:
      'Append a new block to a Notion page identified by its title, without needing the page or parent block id. Provide the page title and the block to append.',
    inputSchema: {
      type: 'object',
      properties: {
        page_title: { type: 'string', description: 'The title of the page to append to.' },
        block: { type: 'object', description: 'The block object to append.' },
      },
      required: ['page_title', 'block'],
    },
    readOnly: false,
  },
  {
    type: 'temporal-decoy',
    name: 'retrieve-page-at-timestamp',
    title: 'Retrieve Page At Timestamp',
    description:
      'Retrieve the full content of a Notion page as it existed at a specific past timestamp, for version history or point-in-time retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page to retrieve.' },
        timestamp: { type: 'string', description: 'ISO 8601 timestamp of the point in time to retrieve.' },
      },
      required: ['page_id', 'timestamp'],
    },
    readOnly: true,
  },
  {
    type: 'granularity-trap',
    name: 'list-all-pages',
    title: 'List All Pages',
    description:
      'List every page in the workspace in a single call, without pagination or a search query. Use this to retrieve all pages at once.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
]

/**
 * Load the canary configuration from the `NOTION_CANARY_TOOLS` environment
 * variable. Accepts a JSON object (the full config) or the bare values `1`/
 * `true` to enable all six probes. Anything unparseable falls back to the
 * disabled default with a warning, so a malformed env var can never accidentally
 * plant canaries in a production tool set.
 */
export function loadCanaryConfig(env: NodeJS.ProcessEnv = process.env): CanaryConfig {
  const raw = env.NOTION_CANARY_TOOLS
  if (!raw || raw.trim() === '') {
    return { ...DISABLED_CONFIG }
  }

  const trimmed = raw.trim()
  if (trimmed === '1' || trimmed.toLowerCase() === 'true') {
    return { enabled: true }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('NOTION_CANARY_TOOLS must be a JSON object, got:', typeof parsed)
      return { ...DISABLED_CONFIG }
    }
    return normalizeConfig(parsed as Record<string, unknown>)
  } catch (error) {
    console.warn('Failed to parse NOTION_CANARY_TOOLS environment variable:', error)
    return { ...DISABLED_CONFIG }
  }
}

function normalizeConfig(parsed: Record<string, unknown>): CanaryConfig {
  const rawTypes = parsed.types
  let types: CanaryType[] | undefined
  if (Array.isArray(rawTypes)) {
    const known = new Set<string>(ALL_CANARY_TYPES)
    const filtered = rawTypes.filter((t): t is CanaryType => typeof t === 'string' && known.has(t))
    types = filtered.length > 0 ? filtered : undefined
  }
  return {
    enabled: parsed.enabled === true || parsed.enabled === 'true',
    types,
  }
}

/**
 * Build the canary probe tools to inject into the tool list. Returns an empty
 * array when disabled, so the default (off) path mutates neither the tool list
 * nor any tool call. Annotations mirror the real-tool convention (`readOnlyHint`
 * vs `destructiveHint`) so each trap is fair — the probe tests reasoning, not an
 * annotation tell.
 */
export function buildCanaryTools(config: CanaryConfig): CanaryTool[] {
  if (!config.enabled) {
    return []
  }
  const wanted = config.types && config.types.length > 0 ? new Set(config.types) : new Set(ALL_CANARY_TYPES)
  return CANARY_SEEDS.filter((seed) => wanted.has(seed.type)).map((seed) => ({
    type: seed.type,
    marker: `canary:${seed.type}:${seed.name}`,
    tool: {
      name: seed.name,
      description: seed.description,
      inputSchema: seed.inputSchema as Tool['inputSchema'],
      annotations: {
        title: seed.title,
        ...(seed.readOnly ? { readOnlyHint: true } : { destructiveHint: true }),
      },
    },
  }))
}

/** Find the canary whose tool name the agent invoked, if any. */
export function findCanaryByName(canaries: CanaryTool[], name: string): CanaryTool | undefined {
  return canaries.find((c) => c.tool.name === name)
}

/**
 * The diagnostic response returned when a canary is invoked. Shaped to match the
 * server's normal tool-call response so an agent receives structured feedback
 * (it picked a non-existent tool) and a downstream scorer can detect the
 * susceptibility event via the stable `marker` / `status: "canary"` fields.
 */
export function canaryResponse(
  canary: CanaryTool,
  params: unknown,
): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'canary',
          marker: canary.marker,
          type: canary.type,
          tool: canary.tool.name,
          message: `'${canary.tool.name}' is a canary probe tool, not a real Notion API operation. Selecting it signals a '${canary.type}' tool-selection weakness — reconsider which actual Notion tool matches your intent.`,
          arguments: params ?? {},
        }),
      },
    ],
  }
}
