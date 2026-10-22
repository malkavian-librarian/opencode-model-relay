import type { Plugin } from "@opencode-ai/plugin"
import { createServer } from "./server"
import { createV2Plugin, PLUGIN_ID } from "./v2"

export const server = ((input: any, options?: unknown) => createServer(process.env)(input, options)) as unknown as Plugin

// OpenCode 2 entry (#56): both layers are exported; each host binary calls what it supports.
// On 1.x the v2 setup() stays dormant (partial ctx) and server() runs; on 2.x the setup() layer
// runs and the v1 hooks stand down (src/v2.ts isV2Active).
export const setup = createV2Plugin(process.env).setup

export default { id: PLUGIN_ID, server, setup }
