// The verified-link files, per host (apps.ts, HOST_VARIANTS): each variant's app claims only its
// own path prefix, and the production host never names development or its public debug key:
// anyone can sign an APK with that key and the development package, and the
// APK picks its own pathPrefix.

import { describe, expect, it } from 'vitest';

import { type AppVariant, LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import { APPLE_TEAM_ID, DEBUG_KEYSTORE_SHA256, HOST_VARIANTS, LINK_APPS, variantsForHost } from '../src/apps';

import { get } from './helpers';

interface Aasa {
    applinks: { details: { appIDs: string[]; components: { '/': string }[] }[] };
    webcredentials: { apps: string[] };
}

interface Statement {
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}

const AASA = '/.well-known/apple-app-site-association';
const ASSET_LINKS = '/.well-known/assetlinks.json';
const dev = LINK_APPS.find((app) => app.variant === 'development');
const DEV_APP_ID = `${APPLE_TEAM_ID}.${dev?.bundleId}`;

/** Whether an AASA component pattern (`*` any run, `?` one character) matches a path. */
const matches = (pattern: string, path: string) =>
    new RegExp(
        `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
    ).test(path);

const aasaOf = async (host: string) => (await (await get(AASA, {}, host)).json()) as Aasa;
const assetLinksOf = async (host: string) => (await (await get(ASSET_LINKS, {}, host)).json()) as Statement[];

const HOSTS: [string, AppVariant[]][] = [
    [LINK_HOST, ['production', 'preview']],
    [LINK_STAGING_HOST, ['development']],
];

describe('which host serves which variants', () => {
    it("matches the app's builds: production and preview on link.socio.sh, development on staging", () => {
        expect(HOST_VARIANTS).toEqual(Object.fromEntries(HOSTS));
    });

    it('answers any other host with a 404, the well-known files and every page included', async () => {
        for (const host of [
            'evil.example.com',
            'link.socio.sh.evil.example',
            'socio.sh',
            'workers.dev',
            '127.0.0.1:8791',
        ]) {
            for (const path of [AASA, ASSET_LINKS, '/app/w/brain.example.com', '/dev/w/brain.example.com']) {
                expect((await get(path, {}, host)).status, `${host}${path}`).toBe(404);
            }
        }
    });

    it("serves a bench's tunnel host as development, and never lets it change a known host", async () => {
        const env = { DEV_LINK_HOST: 'random-words.trycloudflare.com' };
        expect(variantsForHost('random-words.trycloudflare.com', env.DEV_LINK_HOST)).toEqual(['development']);
        expect(variantsForHost('Random-Words.trycloudflare.com', env.DEV_LINK_HOST)).toEqual(['development']);
        expect(variantsForHost('other.trycloudflare.com', env.DEV_LINK_HOST)).toBeNull();
        expect(variantsForHost(LINK_HOST, LINK_HOST)).toEqual(['production', 'preview']);
        const statements = (await (
            await get(ASSET_LINKS, {}, 'random-words.trycloudflare.com', env)
        ).json()) as Statement[];
        expect(statements.map((statement) => statement.target.package_name)).toEqual([dev?.bundleId]);
        expect((await get(ASSET_LINKS, {}, LINK_HOST, { DEV_LINK_HOST: LINK_HOST })).status).toBe(200);
        expect(
            JSON.stringify(await (await get(ASSET_LINKS, {}, LINK_HOST, { DEV_LINK_HOST: LINK_HOST })).json()),
        ).not.toContain(DEBUG_KEYSTORE_SHA256);
    });
});

describe('the production host never names development', () => {
    it('has no debug key, no development package and no development app id, in either file', async () => {
        const assetLinks = JSON.stringify(await assetLinksOf(LINK_HOST));
        const aasa = JSON.stringify(await aasaOf(LINK_HOST));
        expect(assetLinks).not.toContain(DEBUG_KEYSTORE_SHA256);
        expect(assetLinks).not.toContain(`"${dev?.bundleId}"`);
        expect(aasa).not.toContain(DEV_APP_ID);
        expect(aasa).not.toContain('/dev/');
    });

    it('answers every development page with a 404', async () => {
        for (const kind of ['cb', 'c', 'd/brain.example.com', 'i/brain.example.com', 'w/brain.example.com']) {
            expect((await get(`/dev/${kind}`, {}, LINK_HOST)).status, kind).toBe(404);
        }
    });

    it('and staging names nothing but development', async () => {
        expect((await assetLinksOf(LINK_STAGING_HOST)).map((statement) => statement.target)).toEqual([
            {
                namespace: 'android_app',
                package_name: dev?.bundleId,
                sha256_cert_fingerprints: [DEBUG_KEYSTORE_SHA256],
            },
        ]);
        expect((await aasaOf(LINK_STAGING_HOST)).webcredentials.apps).toEqual([DEV_APP_ID]);
        for (const kind of ['cb', 'c', 'd/brain.example.com', 'i/brain.example.com', 'w/brain.example.com']) {
            for (const prefix of ['app', 'preview']) {
                expect((await get(`/${prefix}/${kind}`, {}, LINK_STAGING_HOST)).status, `${prefix} ${kind}`).toBe(404);
            }
        }
    });
});

describe.each(HOSTS)('%s', (host, variants) => {
    const apps = LINK_APPS.filter((app) => variants.includes(app.variant));

    it('serves both files as JSON, without a redirect', async () => {
        for (const path of [AASA, ASSET_LINKS]) {
            const response = await get(path, {}, host);
            expect(response.status, path).toBe(200);
            expect(response.headers.get('content-type'), path).toBe('application/json');
        }
    });

    it("gives each of its variants' app ids its own path prefix and nothing else", async () => {
        const aasa = await aasaOf(host);
        expect(aasa.applinks.details).toHaveLength(apps.length);
        for (const app of apps) {
            const id = `${APPLE_TEAM_ID}.${app.bundleId}`;
            const mine = aasa.applinks.details.filter((detail) => detail.appIDs.includes(id));
            expect(mine, app.variant).toHaveLength(1);
            expect(mine[0]?.appIDs, app.variant).toEqual([id]);
            expect(
                mine[0]?.components.map((component) => component['/']),
                app.variant,
            ).toEqual([`${app.prefix}*`]);
            for (const other of LINK_APPS) {
                for (const kind of ['cb', 'c', 'd/brain.example.com', 'i/brain.example.com', 'w/brain.example.com']) {
                    const path = `${other.prefix}${kind}`;
                    expect(
                        mine[0]?.components.some((component) => matches(component['/'], path)),
                        `${app.variant} ${path}`,
                    ).toBe(other === app);
                }
            }
        }
    });

    it("lists its variants' app ids for webcredentials, which the sheet's https callback needs", async () => {
        expect((await aasaOf(host)).webcredentials.apps).toEqual(apps.map((app) => `${APPLE_TEAM_ID}.${app.bundleId}`));
    });

    it('gives each of its packages its own signing keys, and only handle_all_urls', async () => {
        expect(await assetLinksOf(host)).toEqual(
            apps.map((app) => ({
                relation: ['delegate_permission/common.handle_all_urls'],
                target: {
                    namespace: 'android_app',
                    package_name: app.bundleId,
                    sha256_cert_fingerprints: [...app.androidCertSha256],
                },
            })),
        );
    });
});
