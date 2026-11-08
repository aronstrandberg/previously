import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { Config } from "./config.ts"
import { Embedder } from "./embedder.ts"
import { Handlers } from "./handlers.ts"
import { Searcher } from "./search.ts"
import { Store } from "./store.ts"
import { Syncer, type Log } from "./sync.ts"
import { timeFormatter } from "./time.ts"
import { isToolName, TOOLS, type ToolName } from "./tools.ts"

const EMBED_BATCH = 32
const IDLE_POLL_MS = 30_000
const PROGRESS_LOG_MS = 60_000
const BACKLOG_LOG_THRESHOLD = 1_000
const VERSION = "0.1.0"

export async function serve(config: Config) {
  const log: Log = (message) => console.log(`[opencode-recall] ${message}`)
  const token = loadToken(config)
  const store = new Store(config.databasePath, config.model)
  const embedder = new Embedder(config)
  const searcher = new Searcher(store, embedder)
  const handlers = new Handlers(store, searcher, timeFormatter(config.timeZone))
  const worker = new EmbeddingWorker(store, embedder, log)
  const syncer = new Syncer(store, () => worker.wake(), log)

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    routes: {
      "/health": new Response("ok"),
    },
    async fetch(request) {
      if (!authorized(request, token)) return Response.json({ error: "unauthorized" }, { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === "/mcp") return handleMcp(request, handlers)
      if (url.pathname === "/api/status" && request.method === "GET") return Response.json(store.stats())
      const tool = /^\/api\/tools\/([\w-]+)$/.exec(url.pathname)?.[1]
      if (tool && request.method === "POST") {
        if (!isToolName(tool)) return Response.json({ error: `unknown tool ${tool}` }, { status: 404 })
        try {
          const body = (await request.json()) as { input?: unknown }
          return Response.json({ content: await handlers.call(tool, body.input ?? {}) })
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  log(`listening on http://${server.hostname}:${server.port} (MCP at /mcp), index ${config.databasePath}`)

  worker.start()
  await syncer.start()

  const shutdown = () => {
    log("shutting down")
    syncer.stop()
    worker.stop()
    void server.stop()
    store.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

/** Answers one MCP request with a fresh stateless server; the tools hold no per-client state. */
async function handleMcp(request: Request, handlers: Handlers): Promise<Response> {
  const mcp = new McpServer({ name: "opencode-recall", version: VERSION })
  for (const [name, tool] of Object.entries(TOOLS) as [ToolName, (typeof TOOLS)[ToolName]][]) {
    mcp.registerTool(
      name,
      { description: tool.description, inputSchema: tool.input.shape, annotations: { readOnlyHint: true } },
      async (input: unknown) => {
        try {
          return { content: [{ type: "text" as const, text: await handlers.call(name, input) }] }
        } catch (error) {
          return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true }
        }
      },
    )
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await mcp.connect(transport)
  return transport.handleRequest(request)
}

/** Embeds pending chunks in the background, newest first, and sleeps when there are none. */
class EmbeddingWorker {
  private wakeUp: (() => void) | undefined
  private stopped = false
  private embeddedSinceLog = 0
  private lastProgressLog = Date.now()

  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder,
    private readonly log: Log,
  ) {}

  wake() {
    this.wakeUp?.()
  }

  stop() {
    this.stopped = true
    this.wake()
  }

  start() {
    void this.run()
  }

  private async run() {
    while (!this.stopped) {
      const batch = this.store.pendingChunks(EMBED_BATCH)
      if (batch.length === 0) {
        if (this.embeddedSinceLog >= BACKLOG_LOG_THRESHOLD) this.log(`embeddings up to date (${this.embeddedSinceLog} new)`)
        this.embeddedSinceLog = 0
        await new Promise<void>((resolve) => {
          this.wakeUp = resolve
          setTimeout(resolve, IDLE_POLL_MS)
        })
        this.wakeUp = undefined
        continue
      }
      try {
        const vectors = await this.embedder.passages(batch.map((chunk) => `${chunk.title}\n\n${chunk.text}`))
        this.store.writeEmbeddings(batch.map((chunk, index) => ({ id: chunk.id, vector: vectors[index]! })))
        this.embeddedSinceLog += batch.length
        if (Date.now() - this.lastProgressLog > PROGRESS_LOG_MS) {
          this.lastProgressLog = Date.now()
          this.log(`embedded ${this.embeddedSinceLog} passages, ${this.store.stats().pending} pending`)
        }
      } catch (error) {
        this.log(`embedding failed: ${errorMessage(error)}`)
        await Bun.sleep(IDLE_POLL_MS)
      }
    }
  }
}

/** Reads the bearer token clients must send, creating a random one readable only by this user on first start. */
function loadToken(config: Config): string {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  if (!existsSync(config.tokenPath)) writeFileSync(config.tokenPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 })
  return readFileSync(config.tokenPath, "utf8").trim()
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? ""
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
