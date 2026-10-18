import type { ClientLike, ModelRef } from "./types"
import type { SessionLock } from "./session-lock"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function performSwitch(
  d: { client: ClientLike; lock: SessionLock; abortTimeoutMs?: number; abortDelayMs?: number; log?: (m: string) => void },
  a: { sessionID: string; to: ModelRef; agent?: string; handoverText: string },
): Promise<void> {
  // A throwing log callback must never escape.
  const log = (m: string) => {
    try { d.log?.(m) } catch { /* ignore */ }
  }
  d.lock.markPluginAbort(a.sessionID)

  let timer: ReturnType<typeof setTimeout> | undefined
  let outcome: "ok" | "rejected" | "timeout"
  try {
    // async wrapper so a synchronous throw from abort() becomes a rejection; the
    // .then(ok, rejected) handlers also swallow a late rejection after the timeout fired.
    const abortP = (async () => d.client.session.abort({ path: { id: a.sessionID } }))()
      .then(() => "ok" as const, () => "rejected" as const)
    const timeoutP = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), d.abortTimeoutMs ?? 5000) })
    outcome = await Promise.race([abortP, timeoutP])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  // Mark stays set on ok/timeout (controller swallows the resulting MessageAbortedError);
  // cleared only when abort was rejected (no abort error will arrive).
  if (outcome === "rejected") d.lock.consumePluginAbort(a.sessionID)

  const delay = d.abortDelayMs ?? 300
  if (delay > 0) await new Promise<void>((r) => { setTimeout(r, delay) })

  // Fire without awaiting: session.prompt resolves only when the whole model turn is over.
  try {
    Promise.resolve(
      d.client.session.prompt({
        path: { id: a.sessionID },
        body: {
          model: a.to,
          ...(a.agent ? { agent: a.agent } : {}),
          parts: [{ type: "text", text: a.handoverText }],
        },
      }),
    ).catch((e: unknown) => log(`prompt failed: ${errMsg(e)}`))
  } catch (e) {
    log(`prompt failed: ${errMsg(e)}`)
  }
}
