/**
 * Structural types for the OpenCode 2 plugin ctx (#56), as probed from the real 2.1.3 binary
 * (docs/spike-v2.md). Deliberately narrow and defensive: every field is optional and unknown
 * extra data is tolerated, because the host shape is not under our control and may change.
 * `@opencode-ai/plugin` is kept for v1 typing only — importing its v2 runtime breaks the
 * local plugins-dir build on OpenCode 1.x.
 */

export interface V2ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface V2SessionInfo {
  id?: string
  parentID?: string
  model?: V2ModelRef
  [k: string]: unknown
}

export interface V2Event {
  type?: string
  /** Event payload; `sessionID` lives here on v2 (v1 used a `properties` wrapper). */
  data?: unknown
  [k: string]: unknown
}

export interface V2Message {
  id?: string
  type?: string
  text?: unknown
  content?: unknown[]
  model?: { id?: unknown; providerID?: unknown }
  [k: string]: unknown
}

export interface V2Editor {
  add(tool: Record<string, unknown>): unknown
}

export interface V2SessionDomain {
  hook(name: string, cb: (event: any) => unknown): Promise<unknown>
  get(a: { sessionID: string }): Promise<V2SessionInfo | undefined>
  context(a: { sessionID: string }): Promise<readonly unknown[]>
  switchModel(a: { sessionID: string; model: V2ModelRef }): Promise<unknown>
  prompt(a: { sessionID: string; text: string; agent?: string }): Promise<unknown>
  synthetic(a: { sessionID: string; text: string }): Promise<unknown>
  interrupt(a: { sessionID: string; continue?: boolean }): Promise<unknown>
}

export interface V2Ctx {
  event?: { subscribe(o: { signal: AbortSignal }): AsyncIterable<V2Event> }
  session?: Partial<V2SessionDomain>
  model?: { list(): Promise<{ data?: unknown } | unknown> }
  tool?: { transform(cb: (editor: V2Editor) => unknown): Promise<unknown> }
  command?: { transform(cb: (editor: V2Editor) => unknown): Promise<unknown> }
  /** Never read: may come from an untrusted project tree. */
  options?: unknown
  location?: unknown
  [k: string]: unknown
}
