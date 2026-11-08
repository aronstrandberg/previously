import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import * as sqliteVec from "sqlite-vec"
import type { EmbeddingModel } from "./config.ts"
import type { ChunkKind, IndexedMessage, IndexedSession } from "./extract.ts"
import { EMBEDDED_KINDS, splitText } from "./extract.ts"

const SCHEMA_VERSION = "1"

/** Embedding state of a chunk. */
export const Embedding = { pending: 0, done: 1, skipped: 2 } as const

export interface SessionRow {
  id: string
  parent_id: string | null
  project_id: string
  directory: string
  title: string
  time_created: number
  time_updated: number
  time_archived: number | null
  synced_updated: number
}

export interface MessageRow {
  session_id: string
  id: string
  type: string
  time_created: number
  hash: string
  text: string
}

export interface ChunkRow {
  id: number
  session_id: string
  message_id: string | null
  kind: ChunkKind
  time_created: number
  text: string
}

export interface PendingChunk {
  id: number
  text: string
  title: string
}

export interface Stats {
  sessions: number
  messages: number
  chunks: number
  embedded: number
  pending: number
  model: string
}

/** The search index: sessions, their messages, and the chunks that FTS5 and sqlite-vec index. */
export class Store {
  readonly db: Database

  constructor(path: string, readonly model: EmbeddingModel) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    sqliteVec.load(this.db)
    this.db.run("pragma journal_mode = wal")
    this.db.run("pragma synchronous = normal")
    this.db.run("pragma foreign_keys = on")
    this.db.run("pragma busy_timeout = 5000")
    this.migrate()
  }

  private migrate() {
    this.db.run(`create table if not exists meta (key text primary key, value text not null)`)
    const version = this.meta("schema_version")
    if (version !== undefined && version !== SCHEMA_VERSION)
      throw new Error(`Index schema ${version} is not supported; delete ${this.db.filename} to rebuild it`)

    this.db.run(`
      create table if not exists sessions (
        id text primary key,
        parent_id text,
        project_id text not null,
        directory text not null,
        title text not null,
        time_created integer not null,
        time_updated integer not null,
        time_archived integer,
        synced_updated integer not null default 0
      )`)
    this.db.run(`create index if not exists sessions_time_updated on sessions (time_updated)`)
    this.db.run(`
      create table if not exists messages (
        session_id text not null references sessions (id) on delete cascade,
        id text not null,
        type text not null,
        time_created integer not null,
        hash text not null,
        text text not null,
        primary key (session_id, id)
      ) without rowid`)
    this.db.run(`create index if not exists messages_session_time on messages (session_id, time_created)`)
    this.db.run(`
      create table if not exists chunks (
        id integer primary key,
        session_id text not null references sessions (id) on delete cascade,
        message_id text,
        kind text not null,
        time_created integer not null,
        text text not null,
        embedded integer not null default 0
      )`)
    this.db.run(`create index if not exists chunks_message on chunks (session_id, message_id)`)
    this.db.run(`create index if not exists chunks_pending on chunks (embedded, time_created)`)
    this.db.run(`
      create virtual table if not exists chunks_fts using fts5 (
        text, content = 'chunks', content_rowid = 'id', tokenize = 'porter unicode61'
      )`)
    this.db.run(`
      create trigger if not exists chunks_after_insert after insert on chunks begin
        insert into chunks_fts (rowid, text) values (new.id, new.text);
      end`)
    this.db.run(`
      create trigger if not exists chunks_after_delete after delete on chunks begin
        insert into chunks_fts (chunks_fts, rowid, text) values ('delete', old.id, old.text);
        delete from chunk_vectors where chunk_id = old.id;
      end`)

    const indexedModel = this.meta("model")
    if (indexedModel !== undefined && indexedModel !== this.model.id) {
      this.db.run(`drop table if exists chunk_vectors`)
      this.db.run(`update chunks set embedded = ${Embedding.pending} where embedded = ${Embedding.done}`)
    }
    this.db.run(`
      create virtual table if not exists chunk_vectors using vec0 (
        chunk_id integer primary key,
        embedding float[${this.model.dimensions}] distance_metric = cosine
      )`)
    this.setMeta("model", this.model.id)
    this.setMeta("schema_version", SCHEMA_VERSION)
  }

  meta(key: string): string | undefined {
    const row = this.db.query<{ value: string }, [string]>(`select value from meta where key = ?`).get(key)
    return row?.value
  }

  setMeta(key: string, value: string) {
    this.db.query(`insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value`).run(key, value)
  }

  session(id: string): SessionRow | undefined {
    return this.db.query<SessionRow, [string]>(`select * from sessions where id = ?`).get(id) ?? undefined
  }

  sessions(): SessionRow[] {
    return this.db.query<SessionRow, []>(`select * from sessions`).all()
  }

  /** Inserts or updates session metadata, keeping its sync watermark, and reindexes the title chunk. */
  upsertSession(session: IndexedSession) {
    this.db.transaction(() => {
      const previous = this.session(session.id)
      this.db
        .query(
          `insert into sessions (id, parent_id, project_id, directory, title, time_created, time_updated, time_archived)
           values ($id, $parentID, $projectID, $directory, $title, $created, $updated, $archived)
           on conflict (id) do update set
             parent_id = excluded.parent_id, project_id = excluded.project_id, directory = excluded.directory,
             title = excluded.title, time_created = excluded.time_created, time_updated = excluded.time_updated,
             time_archived = excluded.time_archived`,
        )
        .run({
          id: session.id,
          parentID: session.parentID ?? null,
          projectID: session.projectID,
          directory: session.directory,
          title: session.title,
          created: session.timeCreated,
          updated: session.timeUpdated,
          archived: session.timeArchived ?? null,
        })
      if (previous?.title === session.title) return
      this.db.query(`delete from chunks where session_id = ? and kind = 'title'`).run(session.id)
      if (session.title.trim() !== "") this.insertChunk(session.id, null, "title", session.timeCreated, session.title)
    })()
  }

  /** Time of the newest indexed message. OpenCode's own `updated` time also moves when the service restarts. */
  lastActive(session: SessionRow): number {
    const row = this.db
      .query<{ t: number | null }, [string]>(`select max(time_created) t from messages where session_id = ?`)
      .get(session.id)
    return row?.t ?? session.time_created
  }

  markSynced(id: string, updated: number) {
    this.db.query(`update sessions set synced_updated = ? where id = ?`).run(updated, id)
  }

  deleteSession(id: string) {
    this.db.query(`delete from sessions where id = ?`).run(id)
  }

  messageHashes(sessionID: string): Map<string, { hash: string; timeCreated: number }> {
    const rows = this.db
      .query<{ id: string; hash: string; time_created: number }, [string]>(
        `select id, hash, time_created from messages where session_id = ?`,
      )
      .all(sessionID)
    return new Map(rows.map((row) => [row.id, { hash: row.hash, timeCreated: row.time_created }]))
  }

  /** Replaces messages and their chunks, and deletes the given stale message IDs. */
  writeMessages(sessionID: string, messages: readonly IndexedMessage[], removed: readonly string[]) {
    this.db.transaction(() => {
      const deleteChunks = this.db.query(`delete from chunks where session_id = ? and message_id = ?`)
      const deleteMessage = this.db.query(`delete from messages where session_id = ? and id = ?`)
      for (const id of removed) {
        deleteChunks.run(sessionID, id)
        deleteMessage.run(sessionID, id)
      }
      const upsert = this.db.query(
        `insert into messages (session_id, id, type, time_created, hash, text) values (?, ?, ?, ?, ?, ?)
         on conflict (session_id, id) do update set
           type = excluded.type, time_created = excluded.time_created, hash = excluded.hash, text = excluded.text`,
      )
      for (const message of messages) {
        deleteChunks.run(sessionID, message.id)
        upsert.run(sessionID, message.id, message.type, message.timeCreated, message.hash, message.text)
        for (const part of message.parts)
          for (const piece of splitText(part.text)) this.insertChunk(sessionID, message.id, part.kind, message.timeCreated, piece)
      }
    })()
  }

  private insertChunk(sessionID: string, messageID: string | null, kind: ChunkKind, time: number, text: string) {
    const embedded = EMBEDDED_KINDS.has(kind) ? Embedding.pending : Embedding.skipped
    this.db
      .query(`insert into chunks (session_id, message_id, kind, time_created, text, embedded) values (?, ?, ?, ?, ?, ?)`)
      .run(sessionID, messageID, kind, time, text, embedded)
  }

  /** Returns chunks waiting for an embedding, newest first, so recent work becomes searchable first. */
  pendingChunks(limit: number): PendingChunk[] {
    return this.db
      .query<PendingChunk, [number]>(
        `select c.id, c.text, s.title from chunks c join sessions s on s.id = c.session_id
         where c.embedded = ${Embedding.pending} order by c.time_created desc limit ?`,
      )
      .all(limit)
  }

  writeEmbeddings(rows: readonly { id: number; vector: Float32Array }[]) {
    this.db.transaction(() => {
      const insert = this.db.query(`insert or replace into chunk_vectors (chunk_id, embedding) values (?, ?)`)
      const mark = this.db.query(`update chunks set embedded = ${Embedding.done} where id = ?`)
      for (const row of rows) {
        // The chunk may have been deleted while it was being embedded.
        const exists = this.db.query(`select 1 from chunks where id = ?`).get(row.id)
        if (!exists) continue
        insert.run(BigInt(row.id), new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength))
        mark.run(row.id)
      }
    })()
  }

  stats(): Stats {
    const count = (sql: string) => this.db.query<{ n: number }, []>(sql).get()!.n
    return {
      sessions: count(`select count(*) n from sessions`),
      messages: count(`select count(*) n from messages`),
      chunks: count(`select count(*) n from chunks`),
      embedded: count(`select count(*) n from chunks where embedded = ${Embedding.done}`),
      pending: count(`select count(*) n from chunks where embedded = ${Embedding.pending}`),
      model: this.model.id,
    }
  }

  close() {
    this.db.close()
  }
}
