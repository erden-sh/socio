import { APPLE_TEAM_ID, type LinkApp } from './apps';

// The verified-link files, one entry per variant the requested host serves (apps.ts,
// HOST_VARIANTS): link.socio.sh names production and preview only, never the development package
// or its public debug key; link-staging.socio.sh names development only.
//
// - The AASA: `applinks` claims each variant's own path prefix only (`/app/*` for production,
//   `/preview/*`, `/dev/*`), so a preview build never opens a production link. `webcredentials`
//   lists every variant the host serves: the sign-in sheet's https callback needs it (iOS refuses the callback
//   without it), and it can't be split by path, so what keeps a production callback out of a
//   preview build is the path each sheet waits for (`/<variant path>/cb`).
// - assetlinks.json: each package with its signing key's fingerprints. Android checks the host as
//   a whole; the app's intent filter (`pathPrefix`) is what limits a variant to its own path. That
//   holds only between apps whose keys are private (production's and preview's on link.socio.sh):
//   an APK signed with a public key picks its own pathPrefix, which is why the debug key lives on
//   the staging host alone.
//   Only `handle_all_urls`: the link domain holds no credentials to share.

export function appleAppSiteAssociation(apps: readonly LinkApp[]) {
    return {
        applinks: {
            details: apps.map((app) => ({
                appIDs: [`${APPLE_TEAM_ID}.${app.bundleId}`],
                components: [{ '/': `${app.prefix}*`, comment: `${app.variant} only` }],
            })),
        },
        webcredentials: { apps: apps.map((app) => `${APPLE_TEAM_ID}.${app.bundleId}`) },
    };
}

export function assetLinks(apps: readonly LinkApp[]) {
    return apps.map((app) => ({
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace: 'android_app',
            package_name: app.bundleId,
            sha256_cert_fingerprints: [...app.androidCertSha256],
        },
    }));
}
