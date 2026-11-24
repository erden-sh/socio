// The Workers Rate Limiting binding for tests: fixed windows aligned to the (injected) clock, as
// the binding's are, counting per key. It can't stand in for the binding's per-location,
// eventually consistent counting; nothing under Node can.

export class FakeRateLimit implements RateLimit {
    private readonly counts = new Map<string, { window: number; count: number }>();
    failing = false;
    readonly keys: string[] = [];

    constructor(
        readonly limitPerPeriod: number,
        readonly periodS: 10 | 60,
        private readonly clock: () => number,
    ) {}

    async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
        if (this.failing) {
            throw new Error('rate limiter unavailable');
        }
        this.keys.push(key);
        const window = Math.floor(this.clock() / (this.periodS * 1000));
        const entry = this.counts.get(key);
        const count = entry && entry.window === window ? entry.count + 1 : 1;
        this.counts.set(key, { window, count });
        return { success: count <= this.limitPerPeriod };
    }
}
