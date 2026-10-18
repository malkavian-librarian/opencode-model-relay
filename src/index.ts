import type { Plugin } from "@opencode-ai/plugin"
import { createServer } from "./server"

export const server = ((input: any, options?: unknown) => createServer(process.env)(input, options)) as unknown as Plugin

export default { id: "opencode-model-relay", server }
