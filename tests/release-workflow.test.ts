// The release workflow: least-privilege jobs on Blacksmith runners,
// images published under the repository's own owner, and a registry layer
// cache per image that is never a release tag.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
/** Text without comment lines or trailing comments. */
const uncommented = (text: string) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/\s#.*$/, ''))
        .join('\n');
/** Each top-level job's text, by name. */
const jobsOf = (text: string) =>
    Object.fromEntries(
        text
            .slice(text.indexOf('\njobs:\n'))
            .split(/^ {2}(?=[\w-]+:\n {4})/m)
            .slice(1)
            .map((job) => [job.slice(0, job.indexOf(':')), job]),
    );
const release = uncommented(read('.github/workflows/release-images.yml'));
const releaseJobs = jobsOf(release);
/** A job's permissions block, as `name: level` lines. */
const permissions = (job: string) => {
    const block = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(job);
    return block
        ? block[1]
              .trim()
              .split('\n')
              .map((line) => line.trim())
        : [];
};

describe('release-images.yml', () => {
    it('asks for no permission by default and only what each job needs', () => {
        expect(release).toMatch(/^permissions: \{\}$/m);
        for (const job of ['root', 'socio-coding', 'supervisor']) {
            expect(permissions(releaseJobs[job]), job).toEqual(['contents: read', 'packages: write']);
        }
        expect(permissions(releaseJobs.verify)).toEqual(['packages: read']);
        expect(permissions(releaseJobs.release)).toEqual(['contents: write']);
    });

    it('caches every build in its own image package, under a tag that is never a release tag', () => {
        const builds = release.split('docker buildx build').slice(1);
        expect(builds).toHaveLength(3);
        for (const build of builds) {
            const image = /--tag \$REGISTRY\/\$OWNER\/(.+?):\$\{GITHUB_REF_NAME\}/.exec(build)?.[1];
            expect(image, build).toBeTruthy();
            const ref = `$REGISTRY/$OWNER/${image}:buildcache`;
            expect(build).toContain(`--cache-from type=registry,ref=${ref} \\`);
            expect(build).toContain(`--cache-to type=registry,ref=${ref},mode=max,ignore-error=true \\`);
            // One tag per build: the release tag, never the cache's.
            expect(build.match(/--tag /g)).toHaveLength(1);
        }
        // The cache tag can't be mistaken for a release by the update feed.
        expect('buildcache').not.toMatch(/^v\d/);
        // A builder that can export a registry cache: Blacksmith's, never the docker driver.
        expect(release).not.toMatch(/driver:\s*docker\b/);
    });

    it('verifies exactly the five release tags, and nothing reads the cache tag after the builds', () => {
        expect(releaseJobs.verify).not.toContain('buildcache');
        expect(releaseJobs.release).not.toContain('buildcache');
        const tags = /tags=\(\n([\s\S]*?)\n\s*\)/.exec(releaseJobs.verify)?.[1].trim().split(/\s+/);
        expect(tags).toEqual([
            'company-brain:${GITHUB_REF_NAME}',
            'company-brain-apps:${GITHUB_REF_NAME}',
            'company-brain-coding-git:${GITHUB_REF_NAME}',
            'socio-coding:${GITHUB_REF_NAME}',
            'company-brain-supervisor:${GITHUB_REF_NAME}',
        ]);
        expect(releaseJobs.verify).toContain('grep -q "image.index" /tmp/inspect');
    });

    it('runs every job on Blacksmith runners and publishes under the repository owner', () => {
        expect(Object.keys(releaseJobs)).toEqual(['root', 'socio-coding', 'supervisor', 'verify', 'release']);
        expect([...release.matchAll(/runs-on:\s*(.+)/g)].map((match) => match[1].trim())).toEqual(
            Array(5).fill('blacksmith-4vcpu-ubuntu-2604'),
        );
        expect(release).toMatch(/^ {2}OWNER: \$\{\{ github\.repository_owner \}\}$/m);
        expect(release).not.toMatch(/pull_request/);
    });

    it('pins every action by a full commit SHA', () => {
        for (const [, action] of release.matchAll(/uses:\s*(\S+)/g)) {
            expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        }
    });
});
