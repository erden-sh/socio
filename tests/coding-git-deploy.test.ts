import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';
import { parse } from 'yaml';

// CB-239: coding-git's image stage and compose service, checked as written
// (no container is run): git and the compiled service only, an unprivileged
// user, an internal network shared with the app alone, no capabilities, a
// read-only root, and off unless its profile is chosen.

const root = new URL('../', import.meta.url);

it('builds coding-git from the pinned Node image with git, as node, no dependencies', () => {
    const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
    const stage = dockerfile.split(/^FROM /m).find((part) => /^\S+ AS coding-git$/m.test(part.split('\n')[0]));
    expect(stage).toBeDefined();
    const pinned = /^FROM (node:\S+) AS build$/m.exec(dockerfile)![1];
    expect(stage!.startsWith(`${pinned} AS coding-git`)).toBe(true);
    expect(stage).toContain('apt-get install -y --no-install-recommends git');
    expect(stage).toMatch(/^USER node$/m);
    expect(stage).toContain('CMD ["node", "dist/server/coding-git/main.js"]');
    // No node_modules, no secrets baked in.
    expect(stage).not.toContain('node_modules');
    expect(stage).not.toMatch(/CODING_GIT_SECRET=/);
});

it('runs coding-git on an internal network with the app only, read-only and without capabilities', () => {
    const compose = parse(readFileSync(new URL('.docker/compose.yml', root), 'utf8')) as {
        services: Record<string, Record<string, unknown>>;
        networks: Record<string, { internal?: boolean } | null>;
    };
    const service = compose.services['coding-git'];
    expect(service).toMatchObject({
        profiles: ['coding'],
        build: { target: 'coding-git' },
        networks: ['coding-git-link'],
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
    });
    expect(service.ports).toBeUndefined();
    expect(compose.networks['coding-git-link']).toEqual({ internal: true });
    const members = Object.entries(compose.services)
        .filter(([, entry]) => (entry.networks as string[] | undefined)?.includes('coding-git-link'))
        .map(([name]) => name)
        .sort();
    expect(members).toEqual(['app', 'coding-git']);
});

it('compiles coding-git with the server', () => {
    const config = JSON.parse(readFileSync(new URL('tsconfig.server.json', root), 'utf8')) as {
        include: string[];
    };
    expect(config.include).toContain('src/coding-git');
});
