import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { RecallClient } from "./client.ts"
import { TOOLS, type ToolName } from "./tools.ts"

/**
 * Adds the opencode-recall tools to OpenCode under the `recall` namespace. The tools call the daemon,
 * which holds the index; this plugin loads no model or database itself.
 *
 * Options: `url` (default http://127.0.0.1:4747) and `tokenPath` (default the daemon's token file).
 */
export default Plugin.define({
  id: "recall",
  async setup(ctx) {
    const url = typeof ctx.options.url === "string" ? ctx.options.url : `http://127.0.0.1:${process.env.OPENCODE_RECALL_PORT || 4747}`
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const tokenPath =
      typeof ctx.options.tokenPath === "string"
        ? ctx.options.tokenPath
        : join(process.env.OPENCODE_RECALL_DATA || join(dataHome, "opencode-recall"), "token")
    const client = new RecallClient(url.replace(/\/+$/, ""), tokenPath)

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "recall", description: "Search and read past OpenCode sessions on this machine." })
      for (const [name, tool] of Object.entries(TOOLS) as [ToolName, (typeof TOOLS)[ToolName]][]) {
        editor.add({
          name,
          description: tool.description,
          input: z.toJSONSchema(tool.input, { io: "input" }) as never,
          options: { namespace: "recall", codemode: true },
          execute: async (input, context) => {
            const args = { ...(input as Record<string, unknown>) }
            // Results from the session doing the search are noise, so leave them out unless asked for.
            if (name === "search_sessions" && args.exclude_session_id === undefined) args.exclude_session_id = context.sessionID
            return { content: await client.call(name, args, context.signal) }
          },
        })
      }
    })
  },
})
