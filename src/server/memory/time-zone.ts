import { DEFAULT_TIME_ZONE, ianaTimeZone } from '@socio/shared/time-zone';

import type { ProfileRepository, TimeZoneNotePlace, TimeZoneNoteRepository, TurnTimeZone } from './contract.js';

/**
 * The time zone a turn speaks in (CB-159): see `TurnTimeZone` in the
 * contract for the order it is chosen in.
 */
export async function turnTimeZone(
    profiles: Pick<ProfileRepository, 'get'>,
    userId: string,
    browser?: string,
    shared = false,
    workspaceZone: string = DEFAULT_TIME_ZONE,
): Promise<TurnTimeZone> {
    const record = await profiles.get(userId);
    const profile = ianaTimeZone(record?.fields.timezone);
    if (shared) {
        const zone = record?.shareable ? profile : undefined;
        return zone
            ? { zone, source: 'profile', stored: zone }
            : {
                  zone: ianaTimeZone(workspaceZone) ?? DEFAULT_TIME_ZONE,
                  source: 'workspace',
                  stored: ianaTimeZone(workspaceZone) ?? DEFAULT_TIME_ZONE,
              };
    }
    const sent = ianaTimeZone(browser);
    const [zone, source]: [string, TurnTimeZone['source']] = profile
        ? [profile, 'profile']
        : sent
          ? [sent, 'browser']
          : [DEFAULT_TIME_ZONE, 'default'];
    return { zone, source, stored: zone };
}

/**
 * Whether two zone names are one zone: the same, or one a link to the
 * other, as browsers spell them differently (Chrome's `Asia/Calcutta`,
 * Firefox's `Asia/Kolkata`; `Europe/Kiev`, `Europe/Kyiv`). A person with
 * both never has their zone moved back and forth.
 */
function sameTimeZone(a: string, b: string) {
    const canonical = (zone: string) => {
        try {
            return new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
            }).resolvedOptions().timeZone;
        } catch {
            return zone;
        }
    };
    return a === b || canonical(a) === canonical(b);
}

/**
 * Saves the browser's zone to the person's profile, marked detected, when
 * the profile has no time zone yet, so their Telegram, scheduled and job
 * turns get it too. A detected zone follows the browser when it reports
 * another, not just another name of it (CB-176: they traveled), and
 * `notes` gets a quiet note to tell them once; a zone the person set
 * themselves is never replaced. A zone that isn't a valid IANA name is
 * ignored, and a profile the person cleared is never made again. The
 * browser's zone is still used for the turn it came with. Says whether it
 * saved.
 *
 * The markers already in a chat keep their words (`time-markers.ts`):
 * only new ones, and the turn's note, give the time in the new zone.
 */
export async function rememberBrowserTimeZone(
    profiles: Pick<ProfileRepository, 'get' | 'save' | 'cleared'>,
    userId: string,
    browser: unknown,
    now = Date.now(),
    notes?: Pick<TimeZoneNoteRepository, 'add'>,
): Promise<boolean> {
    const zone = ianaTimeZone(browser);
    if (!zone) {
        return false;
    }
    const profile = await profiles.get(userId);
    const current = profile?.fields.timezone;
    const moved = !!current && !!profile?.timezoneDetected && !sameTimeZone(current, zone);
    if (current && !moved) {
        return false;
    }
    if (!profile && (await profiles.cleared(userId))) {
        return false;
    }
    await profiles.save(
        userId,
        {
            fields: { ...profile?.fields, timezone: zone },
            shareable: profile?.shareable ?? false,
            timezoneDetected: true,
        },
        now,
    );
    if (moved) {
        await notes?.add(userId, zone, now);
    }
    return true;
}

/**
 * The zone of the quiet note still to show the person in `place` (CB-176),
 * while their profile's zone is still that one, detected: a note of a
 * zone they have since changed or set themselves is never shown.
 */
export async function movedTimeZone(
    profiles: Pick<ProfileRepository, 'get'>,
    notes: Pick<TimeZoneNoteRepository, 'pending'>,
    userId: string,
    place: TimeZoneNotePlace,
): Promise<string | undefined> {
    const zone = await notes.pending(userId, place);
    if (!zone) {
        return undefined;
    }
    const profile = await profiles.get(userId);
    return profile?.timezoneDetected && profile.fields.timezone === zone ? zone : undefined;
}
