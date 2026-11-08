import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

/** What a chunk of indexed text came from. */
export type ChunkKind = "title" | "user" | "assistant" | "summary" | "tool"

export const CHUNK_KINDS: readonly ChunkKind[] = ["title", "user", "assistant", "summary", "tool"]

/** Kinds that get an embedding. Tool calls are keyword-searchable only: they are many, short and literal. */
export const EMBEDDED_KINDS: ReadonlySet<ChunkKind> = new Set(["title", "user", "assistant", "summary"])

export interface IndexedSession {
  id: string
  parentID?: string
  projectID: string
  directory: string
  title: string
  timeCreated: number
  timeUpdated: number
  timeArchived?: number
}

export interface IndexedPart {
  kind: Exclude<ChunkKind, "title">
  text: string
}

export interface IndexedMessage {
  id: string
  type: string
  timeCreated: number
  /** Hash of the extracted text, used to skip unchanged messages on resync. */
  hash: string
  /** The message rendered as plain text, for reading transcripts back. */
  text: string
  parts: IndexedPart[]
}

const TOOL_INPUT_LIMIT = 400
const CHUNK_SIZE = 1500
const CHUNK_OVERLAP = 200

export function indexedSession(session: SessionInfo): IndexedSession {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    directory: session.location.directory,
    title: session.title ?? "",
    timeCreated: session.time.created,
    timeUpdated: session.time.updated,
    timeArchived: session.time.archived,
  }
}

export function indexedMessage(message: SessionMessageInfo): IndexedMessage {
  const parts = messageParts(message)
  const text = parts.map(renderPart).join("\n\n")
  return {
    id: message.id,
    type: message.type,
    timeCreated: message.time.created,
    hash: Bun.hash(message.type + "\0" + text).toString(36),
    text,
    parts,
  }
}

function messageParts(message: SessionMessageInfo): IndexedPart[] {
  switch (message.type) {
    case "user":
      return nonEmpty([{ kind: "user", text: message.text }])
    case "assistant": {
      const parts: IndexedPart[] = []
      const tools: string[] = []
      for (const content of message.content) {
        if (content.type === "text") parts.push({ kind: "assistant", text: content.text })
        else if (content.type === "tool") tools.push(`${content.name}: ${summarizeInput(content.state.input)}`)
      }
      if (tools.length > 0) parts.push({ kind: "tool", text: tools.join("\n") })
      return nonEmpty(parts)
    }
    case "compaction":
      return message.status === "completed" ? nonEmpty([{ kind: "summary", text: message.summary }]) : []
    case "shell":
      return nonEmpty([{ kind: "tool", text: `$ ${message.command}` }])
    case "skill":
      return nonEmpty([{ kind: "tool", text: `skill: ${message.name}` }])
    default:
      // Synthetic and system messages carry instructions and catalogs, not conversation.
      return []
  }
}

function nonEmpty(parts: IndexedPart[]): IndexedPart[] {
  return parts.filter((part) => part.text.trim() !== "")
}

function renderPart(part: IndexedPart): string {
  return part.kind === "summary" ? `[summary]\n${part.text}` : part.text
}

/** Picks the most telling field of a tool input, so a tool call reads like `shell: git status`. */
function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return truncate(String(input ?? ""))
  const record = input as Record<string, unknown>
  for (const key of ["command", "code", "query", "pattern", "url", "prompt", "description", "path", "filePath"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return truncate(value)
  }
  return truncate(JSON.stringify(input))
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= TOOL_INPUT_LIMIT ? flat : flat.slice(0, TOOL_INPUT_LIMIT) + "…"
}

/** Splits text into overlapping windows that fit the embedding model, preferring paragraph and line breaks. */
export function splitText(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= CHUNK_SIZE) return trimmed === "" ? [] : [trimmed]
  const chunks: string[] = []
  let start = 0
  while (start < trimmed.length) {
    let end = Math.min(start + CHUNK_SIZE, trimmed.length)
    if (end < trimmed.length) {
      const window = trimmed.slice(start, end)
      const minimum = CHUNK_SIZE / 2
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "))
      if (breakAt > minimum) end = start + breakAt + 1
    }
    chunks.push(trimmed.slice(start, end).trim())
    if (end >= trimmed.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return chunks.filter((chunk) => chunk !== "")
}
