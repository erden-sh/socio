/**
 * Fixed-window counters in memory, per key (a client address, an email, an
 * account). A restart resets them, which a 15-minute window tolerates.
 */
export class RateLimits {
    private windows = new Map<string, { count: number; resetAt: number }>();
    constructor(
        private max: number,
        private windowMs: number,
    ) {}
    /** Counts one use of `key`; false once it is over the limit. */
    take(key: string, now = Date.now()) {
        if (this.windows.size > 10_000) {
            for (const [entry, window] of this.windows) {
                if (window.resetAt <= now) {
                    this.windows.delete(entry);
                }
            }
        }
        const window = this.windows.get(key);
        if (!window || window.resetAt <= now) {
            this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
            return true;
        }
        window.count++;
        return window.count <= this.max;
    }
}
