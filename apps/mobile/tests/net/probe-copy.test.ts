import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hostParts, NOT_AVAILABLE, NOT_SOCIO, probeCopy, type ProbeProblem } from '../../src/net';
import { SERVER_OUTDATED } from '../../src/net/probe-copy';

// The add-workspace screen's words and how it shows a
// host, with its registrable domain emphasized.

describe('probeCopy', () => {
    it('words every redirect problem and every answer that is not a sign-in view as "not a Socio workspace"', () => {
        const problems: ProbeProblem[] = [
            'not-socio',
            'unrecognized-host',
            'redirect-twice',
            'redirect-path',
            'redirect-insecure',
            'redirect-invalid',
        ];
        for (const problem of problems) {
            expect(probeCopy(problem)).toBe(NOT_SOCIO);
        }
    });

    it('words an address the build refuses as not available in the app', () => {
        for (const problem of ['insecure', 'port'] as const) {
            expect(probeCopy(problem)).toBe(NOT_AVAILABLE);
        }
    });

    it('words a server below the minimum version as one that needs an update', () => {
        expect(probeCopy('server-outdated')).toBe(SERVER_OUTDATED);
        expect(SERVER_OUTDATED).toMatch(/needs an update/);
    });
});

describe('hostParts', () => {
    it.each([
        ['brain.example.com', { lead: 'brain.', domain: 'example.com', port: '' }],
        ['a.b.example.com', { lead: 'a.b.', domain: 'example.com', port: '' }],
        ['example.com', { lead: '', domain: 'example.com', port: '' }],
        ['brain.example.com:8443', { lead: 'brain.', domain: 'example.com', port: ':8443' }],
        ['localhost:8199', { lead: '', domain: 'localhost', port: ':8199' }],
        ['127.0.0.1:8199', { lead: '', domain: '127.0.0.1', port: ':8199' }],
        ['[::1]:8199', { lead: '', domain: '[::1]', port: ':8199' }],
        ['brain.xn--bcher-kva.example', { lead: 'brain.', domain: 'xn--bcher-kva.example', port: '' }],
    ])('%s', (host, parts) => {
        expect(hostParts(host)).toEqual(parts);
        expect(parts.lead + parts.domain + parts.port).toBe(host);
    });
});

describe('the add-workspace screens', () => {
    const source = (name: string) => readFileSync(new URL(`../../src/screens/${name}`, import.meta.url), 'utf8');

    // Any https host reaches the probe in every build (owner, 2026-11-15), so a
    // look-alike is caught by the person reading the host: each screen after
    // the probe shows it from the URL, never from branding, and no build tells
    // some hosts apart as built in.
    it('show the host from the URL through WorkspaceHost, and warn about no host as not built in', () => {
        // The probe's found workspace keeps the URL's host (data/first-screen.ts, both ways in),
        // and the first screen shows a Get the app link's host the same way.
        const flow = readFileSync(new URL('../../src/data/first-screen.ts', import.meta.url), 'utf8');
        expect(flow).toMatch(/host: result\.address\.host,/);
        expect(source('first-screen-parts.tsx')).toMatch(/<WorkspaceHost host=\{link\.host\}/);
        for (const screen of ['confirm-workspace.tsx', 'sign-in.tsx']) {
            const code = source(screen);
            expect(code, screen).toMatch(/const \{[^}]*\bhost\b[^}]*\} = route\.params;/);
            expect(code, screen).toMatch(/<WorkspaceHost host=\{host\}/);
            expect(code, screen).not.toMatch(/builtIn|adding-warning/);
        }
    });
});
