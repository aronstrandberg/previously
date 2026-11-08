import { availableParallelism, homedir } from "node:os"
import { join } from "node:path"

export interface EmbeddingModel {
  readonly id: string
  readonly dimensions: number
  readonly pooling: "cls" | "mean"
  /** Prepended to search queries, not to indexed passages. */
  readonly queryPrefix: string
}

const MODELS: Record<string, EmbeddingModel> = {
  "Xenova/bge-small-en-v1.5": {
    id: "Xenova/bge-small-en-v1.5",
    dimensions: 384,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/bge-base-en-v1.5": {
    id: "Xenova/bge-base-en-v1.5",
    dimensions: 768,
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/all-MiniLM-L6-v2": {
    id: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    pooling: "mean",
    queryPrefix: "",
  },
}

export interface Config {
  readonly dataDir: string
  readonly databasePath: string
  readonly tokenPath: string
  readonly host: string
  readonly port: number
  readonly model: EmbeddingModel
  readonly threads: number
  readonly timeZone: string
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`)
  return value
}

export function loadConfig(): Config {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const dataDir = process.env.PREVIOUSLY_DATA || join(dataHome, "previously")
  const modelID = process.env.PREVIOUSLY_MODEL || "Xenova/bge-small-en-v1.5"
  const model = MODELS[modelID]
  if (!model) throw new Error(`Unknown PREVIOUSLY_MODEL ${modelID}. Known models: ${Object.keys(MODELS).join(", ")}`)
  return {
    dataDir,
    databasePath: join(dataDir, "index.db"),
    tokenPath: join(dataDir, "token"),
    host: process.env.PREVIOUSLY_HOST || "127.0.0.1",
    port: positiveInt("PREVIOUSLY_PORT", 4747),
    model,
    threads: positiveInt("PREVIOUSLY_THREADS", Math.max(1, Math.floor(availableParallelism() / 2))),
    timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}
