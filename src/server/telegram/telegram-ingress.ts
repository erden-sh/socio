import '@socio/foundation/no-vendor-telemetry';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { StateStore } from '@copilotkit/channels-core';

export const TELEGRAM_INGRESS_TTL_MS = 300_000;
export const TELEGRAM_INGRESS_PRIMED_AT_KEY = 'telegram:ingress:v1:primed-at';
export interface TelegramIngress {
    botId: string;
    conversationKey: string;
    messageId: string;
    actorId: string;
}
const numericId = (id: string) => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id));
const bounded = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const valid = (threadId: string, messageId: string, ingress: TelegramIngress) =>
    bounded(threadId) &&
    bounded(messageId) &&
    numericId(ingress.botId) &&
    numericId(ingress.actorId) &&
    numericId(ingress.messageId) &&
    /^tg:-?\d{1,16}:(dm|topic:\d{1,16}|user:\d{1,16})$/.test(ingress.conversationKey);

/** The private key never leaves server state; proof binds the exact stored message. */
export function signTelegramIngress(
    secret: string,
    threadId: string,
    messageId: string,
    ingress: TelegramIngress,
): string | undefined {
    if (!valid(threadId, messageId, ingress)) {
        return undefined;
    }
    return createHmac('sha256', secret)
        .update(
            JSON.stringify([
                threadId,
                messageId,
                ingress.botId,
                ingress.conversationKey,
                ingress.messageId,
                ingress.actorId,
            ]),
        )
        .digest('hex');
}
export function verifyTelegramIngress(
    secret: string,
    threadId: string,
    messageId: string,
    ingress: TelegramIngress,
    signature: unknown,
): boolean {
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
        return false;
    }
    const expected = signTelegramIngress(secret, threadId, messageId, ingress);
    return expected !== undefined && timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

/** One stable private key and trust epoch per verified public bot identity. */
export async function bootstrapTelegramIngress(state: StateStore, botId: string) {
    if (!numericId(botId)) {
        throw new Error('Telegram bot identity is invalid.');
    }
    const lockKey = `telegram:ingress:v1:bootstrap:${botId}`;
    const deadline = performance.now() + 15_000;
    let lease = await state.lock.acquire(lockKey, { ttlMs: 10_000 });
    while (!lease && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lease = await state.lock.acquire(lockKey, { ttlMs: 10_000 });
    }
    if (!lease) {
        throw new Error('Telegram ingress state could not be initialized.');
    }
    try {
        const markerKey = `${TELEGRAM_INGRESS_PRIMED_AT_KEY}:${botId}`;
        const priorEpoch = await state.kv.get<number>(markerKey);
        const validEpoch = typeof priorEpoch === 'number' && Number.isSafeInteger(priorEpoch) && priorEpoch >= 0;
        const secretKey = `telegram:ingress:v1:provenance-key:${botId}`;
        const priorSecret = await state.kv.get<string>(secretKey);
        const validSecret = typeof priorSecret === 'string' && /^[a-f0-9]{64}$/.test(priorSecret);
        if (validEpoch && !validSecret) {
            throw new Error('Telegram ingress proof key is missing or invalid.');
        }
        const secret = validSecret ? priorSecret : randomBytes(32).toString('hex');
        // Publish the key first: a crash before the epoch is harmless, never a key fork.
        if (priorSecret !== secret) {
            await state.kv.set(secretKey, secret);
        }
        const primedAt = validEpoch ? priorEpoch : Date.now();
        if (priorEpoch !== primedAt) {
            await state.kv.set(markerKey, primedAt);
        }
        return { primedAt, secret };
    } finally {
        await state.lock.release(lockKey, lease.token);
    }
}
