import { OpenCode, type OpenCodeClient, type SessionInfo, type SessionMessageInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { indexedMessage, indexedSession, type IndexedMessage } from "./extract.ts"
import type { Store } from "./store.ts"

const PAGE_SIZE = 100
const RECONCILE_INTERVAL_MS = 10 * 60_000
const EVENT_DEBOUNCE_MS = 3_000
const RECONNECT_DELAYS_MS = [1_000, 5_000, 15_000, 60_000]

const SESSION_EVENTS = [
  "session.created",
  "session.idle",
  "session.renamed",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.deleted",
  "session.compaction.ended",
  "session.revert.committed",
] as const

export type Log = (message: string) => void

/**
 * Keeps the index in step with the OpenCode background service: a full reconcile on start and every ten
 * minutes, plus session events for changes as they happen. Only reads from OpenCode.
 */
export class Syncer {
  private client: OpenCodeClient | undefined
  private readonly queue = new Map<string, number>()
  private readonly debounce = new Map<string, Timer>()
  private draining: Promise<void> | undefined
  private stopped = false
  private readonly controller = new AbortController()

  constructor(
    private readonly store: Store,
    private readonly onIndexed: () => void,
    private readonly log: Log,
  ) {}

  async start() {
    void this.followEvents()
    const timer = setInterval(() => void this.reconcile().catch((error) => this.log(`reconcile failed: ${message(error)}`)), RECONCILE_INTERVAL_MS)
    this.controller.signal.addEventListener("abort", () => clearInterval(timer))
  }

  stop() {
    this.stopped = true
    this.controller.abort()
    for (const timer of this.debounce.values()) clearTimeout(timer)
  }

  private async connect(): Promise<OpenCodeClient> {
    if (this.client) return this.client
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("no OpenCode background service is running (start one with `opencode serve --service`)")
    this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    return this.client
  }

  /** Forgets the connection so the next call discovers the service again, for example after it restarted. */
  private reset() {
    this.client = undefined
  }

  /** Lists every session, removes deleted ones from the index, and queues those that changed since their last sync. */
  async reconcile() {
    const client = await this.connect()
    const sessions = new Map<string, SessionInfo>()
    for (const archived of [false, true]) {
      let page = await client.session.list({ limit: 500, archived }, { signal: this.controller.signal })
      for (;;) {
        for (const session of page.data) sessions.set(session.id, session)
        if (!page.cursor.next || page.data.length === 0) break
        page = await client.session.list({ cursor: page.cursor.next, limit: 500 }, { signal: this.controller.signal })
      }
    }

    let removed = 0
    for (const row of this.store.sessions())
      if (!sessions.has(row.id)) {
        this.store.deleteSession(row.id)
        removed++
      }

    let queued = 0
    const ordered = [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated)
    for (const session of ordered) {
      const row = this.store.session(session.id)
      this.store.upsertSession(indexedSession(session))
      if (!row || row.synced_updated < session.time.updated) {
        this.enqueue(session.id, session.time.updated)
        queued++
      }
    }
    this.log(`reconciled ${sessions.size} sessions: ${queued} to sync, ${removed} removed`)
    await this.drain()
  }

  private enqueue(sessionID: string, updated: number) {
    this.queue.set(sessionID, Math.max(updated, this.queue.get(sessionID) ?? 0))
    this.draining ??= this.runQueue().finally(() => (this.draining = undefined))
  }

  private drain(): Promise<void> {
    return this.draining ?? Promise.resolve()
  }

  private async runQueue() {
    while (!this.stopped && this.queue.size > 0) {
      const [sessionID, updated] = this.queue.entries().next().value!
      this.queue.delete(sessionID)
      try {
        const changed = await this.syncMessages(sessionID)
        this.store.markSynced(sessionID, updated)
        if (changed > 0) this.onIndexed()
      } catch (error) {
        this.log(`sync ${sessionID} failed: ${message(error)}`)
        if (isConnectionError(error)) {
          // Keep the session queued; the next reconcile after reconnecting drains the queue again.
          this.queue.set(sessionID, updated)
          this.reset()
          return
        }
      }
    }
  }

  /**
   * Reads messages newest first and stops at the first message the index already has unchanged: older
   * messages do not change once a newer one exists. Messages missing from that tail were reverted.
   */
  private async syncMessages(sessionID: string): Promise<number> {
    const client = await this.connect()
    const known = this.store.messageHashes(sessionID)
    const fetched: IndexedMessage[] = []
    let reachedKnown = false
    let page = await client.message.list({ sessionID, limit: PAGE_SIZE, order: "desc" }, { signal: this.controller.signal })
    for (;;) {
      for (const raw of page.data as SessionMessageInfo[]) {
        const message = indexedMessage(raw)
        fetched.push(message)
        if (known.get(message.id)?.hash === message.hash) {
          reachedKnown = true
          break
        }
      }
      if (reachedKnown || !page.cursor.next || page.data.length === 0) break
      page = await client.message.list({ sessionID, cursor: page.cursor.next, limit: PAGE_SIZE }, { signal: this.controller.signal })
    }

    const fetchedIDs = new Set(fetched.map((message) => message.id))
    const oldest = reachedKnown ? fetched.at(-1)!.timeCreated : -Infinity
    const removed = [...known].filter(([id, value]) => value.timeCreated >= oldest && !fetchedIDs.has(id)).map(([id]) => id)
    const changed = fetched.filter((message) => known.get(message.id)?.hash !== message.hash)
    if (changed.length > 0 || removed.length > 0) this.store.writeMessages(sessionID, changed, removed)
    return changed.length + removed.length
  }

  private async followEvents() {
    let attempt = 0
    while (!this.stopped) {
      try {
        const client = await this.connect()
        const events = client.event.subscribe({ types: [...SESSION_EVENTS] })
        for await (const event of events) {
          if (this.stopped) break
          if (event.type === "server.connected") {
            attempt = 0
            void this.reconcile().catch((error) => this.log(`reconcile failed: ${message(error)}`))
            continue
          }
          const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (!sessionID) continue
          if (event.type === "session.deleted") this.store.deleteSession(sessionID)
          else this.scheduleSession(sessionID)
        }
      } catch (error) {
        if (this.stopped) break
        this.log(`event stream failed: ${message(error)}`)
      }
      this.reset()
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)]!
      await Bun.sleep(delay)
    }
  }

  /** Syncs a session shortly after its last event, so a burst of events causes one sync. */
  private scheduleSession(sessionID: string) {
    clearTimeout(this.debounce.get(sessionID))
    this.debounce.set(
      sessionID,
      setTimeout(async () => {
        this.debounce.delete(sessionID)
        try {
          const client = await this.connect()
          const session = await client.session.get({ sessionID }, { signal: this.controller.signal })
          this.store.upsertSession(indexedSession(session))
          this.enqueue(sessionID, session.time.updated)
        } catch (error) {
          this.log(`session ${sessionID} refresh failed: ${message(error)}`)
        }
      }, EVENT_DEBOUNCE_MS),
    )
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionError(error: unknown): boolean {
  const text = message(error).toLowerCase()
  return text.includes("connect") || text.includes("econnrefused") || text.includes("unauthorized") || text.includes("401")
}
