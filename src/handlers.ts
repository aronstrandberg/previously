import type { ChunkKind } from "./extract.ts"
import type { Searcher, SessionResult } from "./search.ts"
import type { MessageRow, SessionRow, Store } from "./store.ts"
import { parseTime } from "./time.ts"
import {
  listSessionsInput,
  readSessionInput,
  searchSessionsInput,
  type ListSessionsInput,
  type ReadSessionInput,
  type SearchSessionsInput,
  type ToolName,
} from "./tools.ts"

const MESSAGE_CHAR_LIMIT = 3_000
const TRANSCRIPT_CHAR_LIMIT = 40_000

/** Runs the tools in {@link TOOLS} against the index and renders plain-text results for a model to read. */
export class Handlers {
  constructor(
    private readonly store: Store,
    private readonly searcher: Searcher,
    private readonly formatTime: (ms: number) => string,
  ) {}

  async call(name: ToolName, input: unknown): Promise<string> {
    switch (name) {
      case "search_sessions":
        return this.searchSessions(searchSessionsInput.parse(input))
      case "read_session":
        return this.readSession(readSessionInput.parse(input))
      case "list_sessions":
        return this.listSessions(listSessionsInput.parse(input))
    }
  }

  async searchSessions(input: SearchSessionsInput): Promise<string> {
    const results = await this.searcher.search({
      query: input.query,
      mode: input.mode,
      limit: input.limit,
      hitsPerSession: 3,
      directory: input.directory,
      since: input.since === undefined ? undefined : parseTime(input.since),
      until: input.until === undefined ? undefined : parseTime(input.until),
      kinds: input.kinds as ChunkKind[] | undefined,
      includeSubagents: input.include_subagents,
      excludeSessionID: input.exclude_session_id,
    })
    if (results.length === 0) return `No sessions match "${input.query}".` + this.pendingNote()
    const blocks = results.map((result, index) => this.renderResult(index + 1, result))
    return (
      blocks.join("\n\n") +
      "\n\nRead around a passage with read_session(session_id, message_id)." +
      this.pendingNote()
    )
  }

  private renderResult(rank: number, result: SessionResult): string {
    const lines = [`${rank}. ${this.sessionLine(result.session, result.parentTitle)}`]
    for (const hit of result.hits) {
      const id = hit.messageID ? ` · ${hit.messageID}` : ""
      lines.push(`   - [${hit.kind} · ${this.formatTime(hit.time)}${id}] ${oneLine(hit.snippet)}`)
    }
    return lines.join("\n")
  }

  private sessionLine(session: SessionRow, parentTitle?: string): string {
    const parts = [
      `${session.title || "(untitled)"} — ${session.id}`,
      `\n   ${session.directory} · created ${this.formatTime(session.time_created)} · last active ${this.formatTime(this.store.lastActive(session))}`,
    ]
    if (session.parent_id) parts.push(` · subagent of "${parentTitle ?? "?"}" (${session.parent_id})`)
    if (session.time_archived) parts.push(" · archived")
    return parts.join("")
  }

  readSession(input: ReadSessionInput): string {
    const session = this.store.session(input.session_id)
    if (!session) return `Session ${input.session_id} is not in the index.`
    const messages = this.transcriptWindow(input)
    if (typeof messages === "string") return messages
    const header = this.sessionLine(session, session.parent_id ? this.store.session(session.parent_id)?.title : undefined)
    let budget = TRANSCRIPT_CHAR_LIMIT
    const rendered: string[] = []
    for (const message of messages) {
      const text = message.text.length > MESSAGE_CHAR_LIMIT ? message.text.slice(0, MESSAGE_CHAR_LIMIT) + "\n[…truncated]" : message.text
      const block = `## ${message.type} · ${this.formatTime(message.time_created)} · ${message.id}\n${text}`
      if (block.length > budget) {
        rendered.push(`[…transcript truncated; continue with message_id ${message.id}]`)
        break
      }
      budget -= block.length
      rendered.push(block)
    }
    return `${header}\n\n${rendered.join("\n\n")}`
  }

  private transcriptWindow(input: ReadSessionInput): MessageRow[] | string {
    const all = this.store.db
      .query<MessageRow, [string]>(
        `select * from messages where session_id = ? and text != '' order by time_created, id`,
      )
      .all(input.session_id)
    if (all.length === 0) return `Session ${input.session_id} has no indexed messages yet.`
    if (input.message_id) {
      const index = all.findIndex((message) => message.id === input.message_id)
      if (index === -1) return `Message ${input.message_id} is not in session ${input.session_id}.`
      return all.slice(Math.max(0, index - input.before), index + input.after)
    }
    return input.from === "start" ? all.slice(0, input.limit) : all.slice(-input.limit)
  }

  listSessions(input: ListSessionsInput): string {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (input.title) {
      clauses.push(`title like ? escape '\\'`)
      params.push(`%${input.title.replace(/[\\%_]/g, (c) => "\\" + c)}%`)
    }
    if (input.directory) {
      const directory = input.directory.replace(/\/+$/, "")
      clauses.push(`(directory = ? or directory like ? escape '\\')`)
      params.push(directory, directory.replace(/[\\%_]/g, (c) => "\\" + c) + "/%")
    }
    if (input.since) {
      clauses.push(`last_active >= ?`)
      params.push(parseTime(input.since))
    }
    if (input.until) {
      clauses.push(`time_created <= ?`)
      params.push(parseTime(input.until))
    }
    if (!input.include_subagents) clauses.push(`parent_id is null`)
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""
    const rows = this.store.db
      .query<SessionRow, (string | number)[]>(
        `select * from (
           select s.*, coalesce((select max(m.time_created) from messages m where m.session_id = s.id), s.time_created) as last_active
           from sessions s
         ) ${where} order by last_active desc limit ${input.limit}`,
      )
      .all(...params)
    if (rows.length === 0) return "No sessions match."
    return rows.map((row, index) => `${index + 1}. ${this.sessionLine(row)}`).join("\n")
  }

  private pendingNote(): string {
    const { pending } = this.store.stats()
    return pending > 0 ? `\n\n(${pending} passages are still waiting for embeddings, so semantic results are incomplete.)` : ""
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
