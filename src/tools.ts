import { z } from "zod"
import { CHUNK_KINDS } from "./extract.ts"

/**
 * The tools both the MCP server and the OpenCode plugin expose. This module holds only names, descriptions
 * and input schemas, so the plugin can import it without loading the index or the embedding model.
 */

const time = z
  .string()
  .describe("An ISO date or time such as 2026-11-01, or a duration back from now such as 30m, 12h, 7d or 2w.")

export const searchSessionsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'What to look for. Natural language works ("how did we fix the flaky gateway test"); wrap exact phrases in double quotes.',
    ),
  limit: z.number().int().min(1).max(30).default(8).describe("Maximum number of sessions to return."),
  mode: z
    .enum(["hybrid", "keyword", "semantic"])
    .default("hybrid")
    .describe(
      "hybrid combines keyword (BM25) and semantic (embedding) ranking. Use keyword for identifiers, file names and error strings.",
    ),
  directory: z.string().optional().describe("Only sessions whose working directory is this path or below it."),
  since: time.optional().describe("Only passages written at or after this time. " + time.description),
  until: time.optional().describe("Only passages written at or before this time. " + time.description),
  kinds: z
    .array(z.enum(CHUNK_KINDS as [string, ...string[]]))
    .optional()
    .describe(
      "Only these kinds of passages: title, user (prompts), assistant (answers), summary (compaction summaries), tool (tool calls and their inputs, keyword-only).",
    ),
  include_subagents: z.boolean().default(true).describe("Include subagent sessions."),
  exclude_session_id: z.string().optional().describe("Leave out this session and its subagents, usually the current one."),
})

export const readSessionInput = z.object({
  session_id: z.string().describe("Session ID, as returned by search_sessions or list_sessions."),
  message_id: z.string().optional().describe("Center the transcript on this message, as returned by search_sessions."),
  before: z.number().int().min(0).max(100).default(5).describe("Messages to show before message_id."),
  after: z.number().int().min(0).max(100).default(15).describe("Messages to show from message_id on."),
  from: z
    .enum(["start", "end"])
    .default("start")
    .describe("Without message_id: read from the start or the end of the session."),
  limit: z.number().int().min(1).max(200).default(30).describe("Without message_id: number of messages to show."),
})

export const listSessionsInput = z.object({
  title: z.string().optional().describe("Only sessions whose title contains this text (case-insensitive)."),
  directory: z.string().optional().describe("Only sessions whose working directory is this path or below it."),
  since: time.optional().describe("Only sessions with a message at or after this time. " + time.description),
  until: time.optional().describe("Only sessions created at or before this time. " + time.description),
  include_subagents: z.boolean().default(false).describe("Include subagent sessions."),
  limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of sessions, newest first."),
})

export type SearchSessionsInput = z.infer<typeof searchSessionsInput>
export type ReadSessionInput = z.infer<typeof readSessionInput>
export type ListSessionsInput = z.infer<typeof listSessionsInput>

export const TOOLS = {
  search_sessions: {
    description:
      "Search past OpenCode sessions on this machine by keyword and meaning. Returns the best-matching sessions with matching passages, message IDs and times. Use it to find earlier work, decisions, commands and explanations, then read_session for context.",
    input: searchSessionsInput,
  },
  read_session: {
    description:
      "Read part of a past OpenCode session transcript: user prompts, assistant answers, compaction summaries and one line per tool call. Tool outputs are not included.",
    input: readSessionInput,
  },
  list_sessions: {
    description: "List past OpenCode sessions, newest first, filtered by title, directory and time.",
    input: listSessionsInput,
  },
} as const

export type ToolName = keyof typeof TOOLS

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name)
}
