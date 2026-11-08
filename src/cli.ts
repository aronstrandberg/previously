#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { PreviouslyClient } from "./client.ts"
import { loadConfig } from "./config.ts"

const USAGE = `previously: search past OpenCode sessions

Usage:
  previously serve                       Run the indexer and the MCP server
  previously search <query> [options]    Search sessions through a running daemon
      --mode hybrid|keyword|semantic          Ranking (default hybrid)
      --limit <n>                             Sessions to return (default 8)
      --directory <path>                      Only sessions under this directory
      --since <time>                          Only passages after a date or duration (7d, 12h)
  previously read <session> [message]    Print part of a session transcript
  previously list [--title <text>]       List sessions, newest first
  previously status                      Show index counts

Environment:
  PREVIOUSLY_PORT     Port to listen on (default 4747)
  PREVIOUSLY_HOST     Address to listen on (default 127.0.0.1)
  PREVIOUSLY_DATA     Index and token directory (default $XDG_DATA_HOME/previously)
  PREVIOUSLY_MODEL    Embedding model (default Xenova/bge-small-en-v1.5)
  PREVIOUSLY_THREADS  Threads for embedding (default half the CPUs)
  TZ                       Time zone for printed times`

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      limit: { type: "string" },
      directory: { type: "string" },
      since: { type: "string" },
      title: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(USAGE)
    return
  }
  const config = loadConfig()
  const client = new PreviouslyClient(`http://${config.host}:${config.port}`, config.tokenPath)
  const limit = values.limit === undefined ? undefined : Number(values.limit)

  switch (command) {
    case "serve": {
      const { serve } = await import("./daemon.ts")
      await serve(config)
      return
    }
    case "search":
      if (rest.length === 0) throw new Error("search needs a query")
      console.log(
        await client.call("search_sessions", {
          query: rest.join(" "),
          mode: values.mode,
          limit,
          directory: values.directory,
          since: values.since,
        }),
      )
      return
    case "read":
      if (!rest[0]) throw new Error("read needs a session ID")
      console.log(await client.call("read_session", { session_id: rest[0], message_id: rest[1], limit }))
      return
    case "list":
      console.log(await client.call("list_sessions", { title: values.title, directory: values.directory, since: values.since, limit }))
      return
    case "status":
      console.log(JSON.stringify(await client.status(), null, 2))
      return
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
