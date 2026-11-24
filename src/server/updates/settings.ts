import {
    parseFeed,
    UPDATE_CHECK_DEFAULT_HOURS,
    UPDATE_CHECK_MAX_HOURS,
    UPDATE_STALE_DEFAULT_DAYS,
    UPDATE_STALE_MAX_DAYS,
    validCheckHours,
    validStaleDays,
    type UpdateFeed,
} from '@socio/shared/updates/updates';

import { GHCR_URL, GITHUB_API_URL, type UpdatesEnvironment } from './contract.js';

const unset = (value: string | undefined) => {
    const trimmed = value?.trim();
    return !trimmed || trimmed.toLowerCase() === 'none' ? undefined : trimmed;
};

const baseUrl = (value: string | undefined, fallback: string, name: string): string => {
    const raw = (value?.trim() || fallback).replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${name} must be an http(s) URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${name} must be an http(s) URL without credentials.`);
    }
    return raw;
};

/**
 * Reads the update settings. `UPDATES_FEED` is `github:owner/repo` (its
 * releases, with notes) or `ghcr:owner/image` (its tags); unset, no feed.
 * `UPDATES_CHECK_HOURS` (24; 0 only by hand), `UPDATES_AUTO_APPLY`
 * (false), `UPDATES_STALE_DAYS` (90; 0 no staleness warning, CB-323). `UPDATER_URL` with `UPDATER_TOKEN` turns on applying through
 * the updater sidecar; a token of `none` (the placeholder secret) leaves it
 * off. Malformed values stop startup, without echoing secrets.
 */
export function updatesFromEnv(env: Record<string, string | undefined>): UpdatesEnvironment {
    const rawFeed = env.UPDATES_FEED?.trim();
    let feed: UpdateFeed | null = null;
    if (rawFeed) {
        const parsed = parseFeed(rawFeed);
        if (!parsed) {
            throw new Error('UPDATES_FEED must be github:<owner>/<repo> or ghcr:<owner>/<image>.');
        }
        feed = parsed;
    }
    const hours = Number(env.UPDATES_CHECK_HOURS?.trim() || UPDATE_CHECK_DEFAULT_HOURS);
    if (!validCheckHours(hours)) {
        throw new Error(`UPDATES_CHECK_HOURS must be whole hours from 0 (only by hand) to ${UPDATE_CHECK_MAX_HOURS}.`);
    }
    const auto = env.UPDATES_AUTO_APPLY?.trim().toLowerCase();
    if (auto && !['true', 'false'].includes(auto)) {
        throw new Error('UPDATES_AUTO_APPLY must be true or false.');
    }
    const staleDays = Number(env.UPDATES_STALE_DAYS?.trim() || UPDATE_STALE_DEFAULT_DAYS);
    if (!validStaleDays(staleDays)) {
        throw new Error(`UPDATES_STALE_DAYS must be whole days from 0 (no warning) to ${UPDATE_STALE_MAX_DAYS}.`);
    }
    const config: UpdatesEnvironment = {
        defaults: { feed, checkHours: hours, autoApply: auto === 'true', staleDays },
        githubApiUrl: baseUrl(env.UPDATES_GITHUB_API_URL, GITHUB_API_URL, 'UPDATES_GITHUB_API_URL'),
        ghcrUrl: baseUrl(env.UPDATES_GHCR_URL, GHCR_URL, 'UPDATES_GHCR_URL'),
    };
    const token = unset(env.UPDATES_FEED_TOKEN);
    if (token) {
        config.token = token;
    }
    const url = env.UPDATER_URL?.trim();
    if (!url) {
        return config;
    }
    const updaterUrl = baseUrl(url, url, 'UPDATER_URL');
    const updaterToken = unset(env.UPDATER_TOKEN);
    if (!updaterToken) {
        return {
            ...config,
            updaterProblem: 'UPDATER_URL is set but UPDATER_TOKEN_FILE is not (or is `none`)',
        };
    }
    if (updaterToken.length < 24) {
        throw new Error('UPDATER_TOKEN must be at least 24 characters.');
    }
    return { ...config, updater: { url: updaterUrl, token: updaterToken } };
}
