import { describe, expect, it } from 'vitest';

import { isUpstreamOrigin, UPSTREAM_BOARD_URL, upstreamIssueLink } from '@socio/shared/updates/upstream';

// CB-381: Socio's own issue keys (release notes, What's New, early-access
// flags) open on the upstream board, except on the upstream instance itself.

describe('upstreamIssueLink', () => {
    it('points at the upstream board from any other instance', () => {
        expect(UPSTREAM_BOARD_URL).toBe('https://brain.ingenioventures.com');
        for (const origin of ['https://lab.example.com', 'http://localhost:3000', undefined]) {
            expect(upstreamIssueLink('CB-157', origin)).toEqual({
                href: 'https://brain.ingenioventures.com/issues/CB-157',
                external: true,
            });
        }
    });

    it('stays a local link on the upstream instance', () => {
        expect(upstreamIssueLink('CB-157', 'https://brain.ingenioventures.com')).toEqual({
            href: '/issues/CB-157',
            external: false,
        });
        expect(isUpstreamOrigin('https://brain.ingenioventures.com/')).toBe(true);
        // Another port, scheme or host is another instance.
        expect(isUpstreamOrigin('https://brain.ingenioventures.com:8443')).toBe(false);
        expect(isUpstreamOrigin('http://brain.ingenioventures.com')).toBe(false);
        expect(isUpstreamOrigin('https://brain.ingenioventures.com.evil.test')).toBe(false);
        expect(isUpstreamOrigin('not a url')).toBe(false);
    });

    it('links only issue keys', () => {
        for (const key of ['CB-0', 'CB-012', 'cb-12', 'CB-1234567890', 'not a key', '../admin', 'CB-12/x']) {
            expect(upstreamIssueLink(key, 'https://lab.example.com')).toBeNull();
        }
    });
});
