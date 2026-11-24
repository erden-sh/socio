import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cb_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `base64url(json).signature`; the payload holds the user id and issue time. */
export function createSessionValue(secret: string, userId: string, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Math.floor(now / 1000) })).toString('base64url');
    return `${payload}.${sign(secret, payload)}`;
}

/** Returns the user id of a valid, unexpired session value, else null. */
export function readSessionValue(secret: string, value: string | undefined, now = Date.now()): string | null {
    if (!value) {
        return null;
    }
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra !== undefined) {
        return null;
    }
    const expected = Buffer.from(sign(secret, payload));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        return null;
    }
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
            uid?: unknown;
            iat?: unknown;
        };
        if (typeof data.uid !== 'string' || typeof data.iat !== 'number') {
            return null;
        }
        if (now / 1000 - data.iat > SESSION_MAX_AGE_SECONDS) {
            return null;
        }
        return data.uid;
    } catch {
        return null;
    }
}

export function sessionCookie(value: string, secure: boolean) {
    return [
        `${SESSION_COOKIE}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        ...(secure ? ['Secure'] : []),
    ].join('; ');
}

export function clearedSessionCookie(secure: boolean) {
    return [
        `${SESSION_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=0',
        ...(secure ? ['Secure'] : []),
    ].join('; ');
}

export function cookieValue(request: Request, name: string) {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return rest.join('=');
        }
    }
    return undefined;
}
