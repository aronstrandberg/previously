import { readFileSync } from "node:fs"
import type { Stats } from "./store.ts"
import type { ToolName } from "./tools.ts"

/** Calls a running previously daemon over its JSON API. */
export class PreviouslyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenPath: string,
  ) {}

  private headers(): Record<string, string> {
    let token: string
    try {
      token = readFileSync(this.tokenPath, "utf8").trim()
    } catch {
      throw new Error(`previously token not found at ${this.tokenPath}; is the daemon set up? Run \`previously serve\`.`)
    }
    return { authorization: `Bearer ${token}`, "content-type": "application/json" }
  }

  async call(tool: ToolName, input: unknown, signal?: AbortSignal): Promise<string> {
    const response = await this.request(`/api/tools/${tool}`, { method: "POST", body: JSON.stringify({ input }), signal })
    const body = (await response.json()) as { content?: string; error?: string }
    if (!response.ok || body.content === undefined) throw new Error(body.error ?? `previously returned ${response.status}`)
    return body.content
  }

  async status(): Promise<Stats> {
    const response = await this.request("/api/status", { method: "GET" })
    if (!response.ok) throw new Error(`previously returned ${response.status}`)
    return (await response.json()) as Stats
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, { ...init, headers: this.headers() })
    } catch (error) {
      if (error instanceof Error && error.message.includes("token not found")) throw error
      throw new Error(`previously is not reachable at ${this.baseUrl}. Start it with \`previously serve\`.`)
    }
  }
}
