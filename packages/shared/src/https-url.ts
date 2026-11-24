import { z } from 'zod';

/** An https URL with no userinfo. `javascript:` is not a URL we will store. */
export function isHttpsUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

export const httpsUrlSchema = z.string().trim().max(500).refine(isHttpsUrl, 'sourceUrl must be an https URL.');
