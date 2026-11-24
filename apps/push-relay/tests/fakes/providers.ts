// The relay's APNs and FCM clients, faked: records every delivery and answers from a script.

import type { Delivery, Outcome, Providers } from '../../src/providers';

export class FakeProviders implements Providers {
    readonly deliveries: Delivery[] = [];
    /** Answers in order; `sent` once they run out. A function decides per delivery. */
    script: (Outcome | Error | ((delivery: Delivery) => Outcome | Promise<Outcome>))[] = [];

    async send(delivery: Delivery): Promise<Outcome> {
        this.deliveries.push(delivery);
        const next = this.script.shift() ?? 'sent';
        if (next instanceof Error) {
            throw next;
        }
        return typeof next === 'function' ? next(delivery) : next;
    }
}
