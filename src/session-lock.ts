export class SessionLock {
  private held = new Set<string>()
  private aborts = new Map<string, number>()
  private seen = new Map<string, number>()

  constructor(
    private now: () => number = Date.now,
    private abortTtlMs = 10_000,
    private dedupTtlMs = 30_000,
  ) {}

  tryAcquire(id: string): boolean {
    if (this.held.has(id)) return false
    this.held.add(id)
    return true
  }
  release(id: string): void { this.held.delete(id) }

  markPluginAbort(id: string): void {
    const t = this.now()
    for (const [k, exp] of this.aborts) if (exp < t) this.aborts.delete(k)
    this.aborts.set(id, t + this.abortTtlMs)
  }
  consumePluginAbort(id: string): boolean {
    const exp = this.aborts.get(id)
    if (exp === undefined) return false
    this.aborts.delete(id)
    return exp >= this.now()
  }

  isDuplicate(key: string): boolean {
    const t = this.now()
    for (const [k, exp] of this.seen) if (exp < t) this.seen.delete(k)
    if (this.seen.has(key)) return true
    this.seen.set(key, t + this.dedupTtlMs)
    return false
  }
}
