import type { Keys } from '../data/keys';
import { isPushRevocationKey, parsePushRevocation } from '../data/push-revocation';

import type { RelayClient, RelayWriteOutcome } from './relay-client';

// Push revocation records (src/data/push-revocation.ts): each wipe keeps
// the workspace's relay registration in one, and this tells the relay, with the
// secret alone (`DELETE /v1/registrations/:id`, no cookie). It runs at once
// after a wipe keeps one, at launch and on each return to the foreground
// (src/platform/push.ts). Only the relay's own answers drop the record: done
// (2xx), 410 (it has no such registration) and its 403 problem (`forbidden`:
// the secret isn't the registration's, so it isn't ours to delete). Anything
// else keeps it for the next try: no answer, a 5xx, and any other 4xx, which a
// proxy or captive portal in the way may send. A registration nobody
// refreshes is gone from the relay after 60 days, and its 410 then drops the
// record.
//
// Each record goes to the relay it was made at: its own `origin`, or the
// build's for one kept before records had one. A record whose relay this
// build can't reach (no relay for an old record, an origin the variant
// doesn't take) is kept untried, for a build that can.

/**
 * The relay client a record's origin goes to, or null when this build can't
 * reach it; `null` asks for the build's own relay (a record with no origin).
 * A lone client answers for every record (tests, a build with one relay).
 */
export type RevocationRelays =
    | Pick<RelayClient, 'remove'>
    | ((origin: string | null) => Pick<RelayClient, 'remove'> | null);

/** Whether the relay's answer settles the record. */
function settled(outcome: RelayWriteOutcome): boolean {
    switch (outcome.kind) {
        case 'done':
        case 'gone':
        case 'forbidden':
            return true;
        case 'offline':
        case 'refused':
            return false;
    }
}

/**
 * Tries the record `name` once at its own relay. A record that can't be read
 * is dropped. Resolves whether it is left; never rejects for a request.
 */
export async function retryPushRevocation(keys: Keys, name: string, relays: RevocationRelays): Promise<boolean> {
    const record = parsePushRevocation(await keys.read(name));
    if (record === null) {
        await keys.delete([name]);
        return false;
    }
    const relay = typeof relays === 'function' ? relays(record.origin ?? null) : relays;
    if (relay === null) {
        return true;
    }
    if (settled(await relay.remove(record.id, record.secret))) {
        await keys.delete([name]);
        return false;
    }
    return true;
}

/**
 * Tries every push revocation record once, each at its own relay. A record
 * that can't be read is dropped. Resolves how many are left; never rejects
 * for a request.
 */
export async function retryPushRevocations(keys: Keys, relays: RevocationRelays): Promise<number> {
    let left = 0;
    for (const name of (await keys.indexed()).filter(isPushRevocationKey)) {
        if (await retryPushRevocation(keys, name, relays)) {
            left += 1;
        }
    }
    return left;
}
