import { readFileSync } from "node:fs"
import type { Stats } from "./store.ts"
import type { ToolName } from "./tools.ts"

/** Calls a running opencode-recall daemon over its JSON API. */
export class RecallClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenPath: string,
  ) {}

  private headers(): Record<string, string> {
    let token: string
    try {
      token = readFileSync(this.tokenPath, "utf8").trim()
    } catch {
      throw new Error(`opencode-recall token not found at ${this.tokenPath}; is the daemon set up? Run \`opencode-recall serve\`.`)
    }
    return { authorization: `Bearer ${token}`, "content-type": "application/json" }
  }

  async call(tool: ToolName, input: unknown, signal?: AbortSignal): Promise<string> {
    const response = await this.request(`/api/tools/${tool}`, { method: "POST", body: JSON.stringify({ input }), signal })
    const body = (await response.json()) as { content?: string; error?: string }
    if (!response.ok || body.content === undefined) throw new Error(body.error ?? `opencode-recall returned ${response.status}`)
    return body.content
  }

  async status(): Promise<Stats> {
    const response = await this.request("/api/status", { method: "GET" })
    if (!response.ok) throw new Error(`opencode-recall returned ${response.status}`)
    return (await response.json()) as Stats
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, { ...init, headers: this.headers() })
    } catch (error) {
      if (error instanceof Error && error.message.includes("token not found")) throw error
      throw new Error(`opencode-recall is not reachable at ${this.baseUrl}. Start it with \`opencode-recall serve\`.`)
    }
  }
}
