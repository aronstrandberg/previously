import type { Embedder } from "./embedder.ts"
import type { ChunkKind } from "./extract.ts"
import type { SessionRow, Store } from "./store.ts"

export type SearchMode = "hybrid" | "keyword" | "semantic"

export interface SearchFilters {
  /** Only sessions whose directory starts with this path. */
  directory?: string
  since?: number
  until?: number
  kinds?: readonly ChunkKind[]
  includeSubagents?: boolean
  excludeSessionID?: string
}

export interface SearchRequest extends SearchFilters {
  query: string
  mode: SearchMode
  /** Maximum number of sessions returned. */
  limit: number
  /** Maximum number of matching passages shown per session. */
  hitsPerSession: number
}

export interface Hit {
  chunkID: number
  messageID: string | null
  kind: ChunkKind
  time: number
  snippet: string
  score: number
}

export interface SessionResult {
  session: SessionRow
  parentTitle?: string
  score: number
  hits: Hit[]
}

interface Candidate {
  chunkID: number
  snippet?: string
}

interface ChunkDetails {
  id: number
  session_id: string
  message_id: string | null
  kind: ChunkKind
  time_created: number
  text: string
}

const RRF_K = 60
const KEYWORD_CANDIDATES = 200
const SEMANTIC_CANDIDATES = 400
const SNIPPET_LENGTH = 320

/** Hybrid search: BM25 over FTS5 and cosine KNN over sqlite-vec, fused with reciprocal rank fusion, grouped by session. */
export class Searcher {
  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder,
  ) {}

  async search(request: SearchRequest): Promise<SessionResult[]> {
    const lists: Candidate[][] = []
    if (request.mode !== "semantic") lists.push(this.keyword(request))
    if (request.mode !== "keyword") lists.push(await this.semantic(request))

    const scores = new Map<number, { score: number; snippet?: string }>()
    for (const list of lists)
      list.forEach((candidate, rank) => {
        const entry = scores.get(candidate.chunkID) ?? { score: 0 }
        entry.score += 1 / (RRF_K + rank + 1)
        entry.snippet ??= candidate.snippet
        scores.set(candidate.chunkID, entry)
      })

    const details = this.chunkDetails([...scores.keys()])
    const bySession = new Map<string, Hit[]>()
    for (const chunk of details) {
      const entry = scores.get(chunk.id)!
      const hits = bySession.get(chunk.session_id) ?? []
      hits.push({
        chunkID: chunk.id,
        messageID: chunk.message_id,
        kind: chunk.kind,
        time: chunk.time_created,
        snippet: entry.snippet ?? excerpt(chunk.text, request.query),
        score: entry.score,
      })
      bySession.set(chunk.session_id, hits)
    }

    const results: SessionResult[] = []
    for (const [sessionID, hits] of bySession) {
      const session = this.store.session(sessionID)
      if (!session) continue
      hits.sort((a, b) => b.score - a.score)
      // Overlapping chunks of one message match together; show each message once.
      const seen = new Set<string>()
      const distinct = hits.filter((hit) => {
        const key = hit.messageID ?? `chunk:${hit.chunkID}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      // The best passage counts most; more matching messages raise the session a little.
      const score = distinct.slice(0, 3).reduce((sum, hit, index) => sum + hit.score / 2 ** index, 0)
      const parentTitle = session.parent_id ? this.store.session(session.parent_id)?.title : undefined
      results.push({ session, parentTitle, score, hits: distinct.slice(0, request.hitsPerSession) })
    }
    return results.sort((a, b) => b.score - a.score).slice(0, request.limit)
  }

  private keyword(request: SearchRequest): Candidate[] {
    const match = ftsQuery(request.query)
    if (match === "") return []
    const filter = filterSql(request)
    return this.store.db
      .query<{ id: number; snippet: string }, any[]>(
        `select c.id, snippet(chunks_fts, 0, '', '', '…', 48) as snippet
         from chunks_fts
         join chunks c on c.id = chunks_fts.rowid
         join sessions s on s.id = c.session_id
         where chunks_fts match ? ${filter.sql}
         order by bm25(chunks_fts)
         limit ${KEYWORD_CANDIDATES}`,
      )
      .all(match, ...filter.params)
      .map((row) => ({ chunkID: row.id, snippet: row.snippet }))
  }

  private async semantic(request: SearchRequest): Promise<Candidate[]> {
    const vector = await this.embedder.query(request.query)
    const nearest = this.store.db
      .query<{ chunk_id: number }, [Uint8Array]>(
        `select chunk_id from chunk_vectors where embedding match ? and k = ${SEMANTIC_CANDIDATES} order by distance`,
      )
      .all(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
      .map((row) => Number(row.chunk_id))
    if (nearest.length === 0) return []

    // sqlite-vec cannot filter on joined columns, so filter the nearest neighbours afterwards, keeping their order.
    const filter = filterSql(request)
    const allowed = new Set(
      this.store.db
        .query<{ id: number }, any[]>(
          `select c.id from chunks c join sessions s on s.id = c.session_id
           where c.id in (select value from json_each(?)) ${filter.sql}`,
        )
        .all(JSON.stringify(nearest), ...filter.params)
        .map((row) => row.id),
    )
    return nearest.filter((id) => allowed.has(id)).map((chunkID) => ({ chunkID }))
  }

  private chunkDetails(ids: number[]): ChunkDetails[] {
    if (ids.length === 0) return []
    return this.store.db
      .query<ChunkDetails, [string]>(
        `select id, session_id, message_id, kind, time_created, text from chunks where id in (select value from json_each(?))`,
      )
      .all(JSON.stringify(ids))
  }
}

function filterSql(filters: SearchFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filters.directory) {
    clauses.push(`(s.directory = ? or s.directory like ? escape '\\')`)
    const directory = filters.directory.replace(/\/+$/, "")
    params.push(directory, directory.replace(/[\\%_]/g, (c) => "\\" + c) + "/%")
  }
  if (filters.since !== undefined) {
    clauses.push(`c.time_created >= ?`)
    params.push(filters.since)
  }
  if (filters.until !== undefined) {
    clauses.push(`c.time_created <= ?`)
    params.push(filters.until)
  }
  if (filters.kinds && filters.kinds.length > 0) {
    clauses.push(`c.kind in (${filters.kinds.map(() => "?").join(", ")})`)
    params.push(...filters.kinds)
  }
  if (filters.includeSubagents === false) clauses.push(`s.parent_id is null`)
  if (filters.excludeSessionID) {
    clauses.push(`s.id != ? and coalesce(s.parent_id, '') != ?`)
    params.push(filters.excludeSessionID, filters.excludeSessionID)
  }
  return { sql: clauses.map((clause) => `and ${clause}`).join(" "), params }
}

/**
 * Turns free text into an FTS5 query: quoted phrases stay phrases, other words are OR-ed so BM25 ranks
 * passages that match more and rarer terms first.
 */
export function ftsQuery(text: string): string {
  const terms: string[] = []
  const rest = text.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const words = tokens(phrase)
    if (words.length > 0) terms.push(`"${words.join(" ")}"`)
    return " "
  })
  for (const word of tokens(rest)) terms.push(`"${word}"`)
  return [...new Set(terms)].join(" OR ")
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

/** Cuts a window of the chunk around the first query word it contains. */
function excerpt(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= SNIPPET_LENGTH) return flat
  const lower = flat.toLowerCase()
  const at = tokens(query)
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  const start = at === undefined ? 0 : Math.max(0, at - SNIPPET_LENGTH / 3)
  const window = flat.slice(start, start + SNIPPET_LENGTH)
  return (start > 0 ? "…" : "") + window + (start + SNIPPET_LENGTH < flat.length ? "…" : "")
}
