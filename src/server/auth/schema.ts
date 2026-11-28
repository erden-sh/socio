import type { SchemaSet } from '@socio/data/migrate';

/**
 * Better Auth's tables (users, sessions, accounts, verification tokens,
 * passkeys), under `auth_` names. The SQL is what Better Auth's own
 * generator produces for our options (`compileMigrations`); a test checks
 * that it still matches after an upgrade. `appUserId` links a sign-in
 * account to the app's `users` row that owns the data; `role` is ours.
 * Migrated with every provider, so switching to Better Auth needs no step.
 */
export const authSchema: SchemaSet = {
    id: 'auth',
    migrations: [
        {
            version: 1,
            name: 'better-auth tables',
            up: `CREATE TABLE "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "appUserId" text unique, "role" text);
CREATE TABLE "auth_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);
CREATE TABLE "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "auth_passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);
CREATE INDEX "auth_session_userId_idx" on "auth_session" ("userId");
CREATE INDEX "auth_account_userId_idx" on "auth_account" ("userId");
CREATE INDEX "auth_verification_identifier_idx" on "auth_verification" ("identifier");
CREATE INDEX "auth_passkey_userId_idx" on "auth_passkey" ("userId");
CREATE INDEX "auth_passkey_credentialID_idx" on "auth_passkey" ("credentialID");`,
        },
        {
            // Deactivation: Better Auth's admin plugin's columns. `banned`
            // refuses new sessions; the reason and expiry stay unset (a
            // deactivation lasts until a reactivation). `impersonatedBy` comes
            // with the plugin; impersonation is not used.
            version: 2,
            name: 'deactivation',
            up: `ALTER TABLE "auth_user" ADD COLUMN "banned" integer default 0;
ALTER TABLE "auth_user" ADD COLUMN "banReason" text;
ALTER TABLE "auth_user" ADD COLUMN "banExpires" date;
ALTER TABLE "auth_session" ADD COLUMN "impersonatedBy" text;`,
        },
        {
            // Connected agents (CB-90): the OAuth provider plugin's tables
            // (clients by their metadata document, the MCP resource, consents,
            // and the hashed access and refresh tokens), under `auth_oauth_`
            // names. Grants themselves are in agents/grants.ts.
            version: 3,
            name: 'oauth provider',
            up: `CREATE TABLE "auth_oauth_client" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "auth_user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
CREATE TABLE "auth_oauth_resource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
CREATE TABLE "auth_oauth_client_resource" ("id" text not null primary key, "clientId" text not null references "auth_oauth_client" ("clientId") on delete cascade, "resourceId" text not null references "auth_oauth_resource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
CREATE TABLE "auth_oauth_refresh_token" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "auth_oauth_client" ("clientId") on delete cascade, "sessionId" text references "auth_session" ("id") on delete set null, "userId" text not null references "auth_user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
CREATE TABLE "auth_oauth_access_token" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "auth_oauth_client" ("clientId") on delete cascade, "sessionId" text references "auth_session" ("id") on delete set null, "userId" text references "auth_user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "auth_oauth_refresh_token" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
CREATE TABLE "auth_oauth_consent" ("id" text not null primary key, "clientId" text not null references "auth_oauth_client" ("clientId") on delete cascade, "userId" text references "auth_user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "auth_oauth_client_assertion" ("id" text not null primary key, "expiresAt" date not null);
CREATE INDEX "auth_oauth_client_userId_idx" on "auth_oauth_client" ("userId");
CREATE INDEX "auth_oauth_client_resource_clientId_idx" on "auth_oauth_client_resource" ("clientId");
CREATE INDEX "auth_oauth_client_resource_resourceId_idx" on "auth_oauth_client_resource" ("resourceId");
CREATE INDEX "auth_oauth_refresh_token_clientId_idx" on "auth_oauth_refresh_token" ("clientId");
CREATE INDEX "auth_oauth_refresh_token_sessionId_idx" on "auth_oauth_refresh_token" ("sessionId");
CREATE INDEX "auth_oauth_refresh_token_userId_idx" on "auth_oauth_refresh_token" ("userId");
CREATE INDEX "auth_oauth_refresh_token_authorizationCodeId_idx" on "auth_oauth_refresh_token" ("authorizationCodeId");
CREATE INDEX "auth_oauth_access_token_clientId_idx" on "auth_oauth_access_token" ("clientId");
CREATE INDEX "auth_oauth_access_token_sessionId_idx" on "auth_oauth_access_token" ("sessionId");
CREATE INDEX "auth_oauth_access_token_userId_idx" on "auth_oauth_access_token" ("userId");
CREATE INDEX "auth_oauth_access_token_authorizationCodeId_idx" on "auth_oauth_access_token" ("authorizationCodeId");
CREATE INDEX "auth_oauth_access_token_refreshId_idx" on "auth_oauth_access_token" ("refreshId");
CREATE INDEX "auth_oauth_consent_clientId_idx" on "auth_oauth_consent" ("clientId");
CREATE INDEX "auth_oauth_consent_userId_idx" on "auth_oauth_consent" ("userId");
CREATE UNIQUE INDEX "auth_oauth_client_resource_clientId_resourceId_uidx" on "auth_oauth_client_resource" ("clientId", "resourceId");`,
        },
        {
            // CB-124: the access policy operators narrow in the app (one row; the
            // environment stays the ceiling), its audit (append-only: the
            // triggers refuse edits and deletes), and how each session began, so
            // a method turned off ends the sessions it made.
            version: 4,
            name: 'access policy',
            compatible:
                'Its refusing triggers are on the audit table it creates, which no older build writes; the session column it adds is nullable (CB-108).',
            up: `CREATE TABLE access_policy(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL CHECK(version >= 1), policy TEXT NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy) > 0));
CREATE TABLE access_policy_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL CHECK(length(actor) > 0), action TEXT NOT NULL CHECK(action IN ('change','reset','step_up_failed','step_up_locked')), stepUp TEXT, detail TEXT NOT NULL DEFAULT '', before TEXT, after TEXT, sessionsEnded INTEGER NOT NULL DEFAULT 0, codeRunsStopped INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER access_policy_audit_no_update BEFORE UPDATE ON access_policy_audit BEGIN SELECT RAISE(ABORT, 'The access policy audit is append-only.'); END;
CREATE TRIGGER access_policy_audit_no_delete BEFORE DELETE ON access_policy_audit BEGIN SELECT RAISE(ABORT, 'The access policy audit is append-only.'); END;
ALTER TABLE "auth_session" ADD COLUMN "signInMethod" text;`,
        },
        {
            // CB-360: when each account was first and last seen making a
            // signed-in request, for admins' roster. Sessions go when they end,
            // and the app's users table is written at boot, so neither says it.
            version: 5,
            name: 'account activity',
            phase: 'expand',
            up: `CREATE TABLE auth_activity(accountId TEXT PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE, firstAt INTEGER NOT NULL, lastAt INTEGER NOT NULL);`,
        },
        {
            // CB-376: who may run code is a permission, given by groups. Better
            // Auth's organization plugin with dynamic access control (teams off):
            // its tables under `auth_` names, as its generator makes them, and
            // `label` on the runtime roles (a group's name). Then the one hidden
            // workspace organization, and a member row for every account, its
            // base role following Socio's (admins and operators are `admin`).
            // The user hooks keep both for accounts made later (better-auth.ts).
            version: 6,
            name: 'groups',
            phase: 'expand',
            up: `ALTER TABLE "auth_session" ADD COLUMN "activeOrganizationId" text;
CREATE TABLE "auth_organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);
CREATE TABLE "auth_organization_role" ("id" text not null primary key, "organizationId" text not null references "auth_organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" date not null, "updatedAt" date, "label" text);
CREATE TABLE "auth_member" ("id" text not null primary key, "organizationId" text not null references "auth_organization" ("id") on delete cascade, "userId" text not null references "auth_user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);
CREATE TABLE "auth_invitation" ("id" text not null primary key, "organizationId" text not null references "auth_organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "auth_user" ("id") on delete cascade);
CREATE INDEX "auth_organization_role_organizationId_idx" on "auth_organization_role" ("organizationId");
CREATE INDEX "auth_organization_role_role_idx" on "auth_organization_role" ("role");
CREATE INDEX "auth_member_organizationId_idx" on "auth_member" ("organizationId");
CREATE INDEX "auth_member_userId_idx" on "auth_member" ("userId");
CREATE INDEX "auth_invitation_organizationId_idx" on "auth_invitation" ("organizationId");
CREATE INDEX "auth_invitation_email_idx" on "auth_invitation" ("email");
INSERT INTO "auth_organization" ("id", "name", "slug", "createdAt") VALUES ('workspace', 'Workspace', 'workspace', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO "auth_member" ("id", "organizationId", "userId", "role", "createdAt") SELECT lower(hex(randomblob(16))), 'workspace', "id", CASE WHEN "role" IN ('admin', 'operator') THEN 'admin' ELSE 'member' END, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "auth_user";`,
        },
        {
            // A session with no sign-in method (from before CB-124, sliding
            // ever since, or a password change of one) can't be checked
            // against the access policy, so `sessionAllowed` now refuses it.
            // Ended here too, not only at its next request: Better Auth's own
            // endpoints read sessions without that check. Which method made it
            // can't be told from the account (a sign-in link needs no
            // credential, and most accounts have more than one), so it isn't
            // guessed: the person signs in again, once.
            version: 7,
            name: 'end sessions without a sign-in method',
            phase: 'expand',
            compatible:
                'Only deletes sessions, as a sign-out or a policy change does: every build since CB-124 reads a missing session as signed out, and the OAuth tokens that name one set it null.',
            up: `DELETE FROM "auth_session" WHERE "signInMethod" IS NULL;`,
        },
        {
            // CB-352: the app's devices, one row per install, person
            // and workspace, found by the SHA-256 of the install id the app
            // sends (never the id itself), with its latest session's expiry
            // (why the app's 401 says expired after the session row is gone);
            // the session's device, whose sessions last 30 days; and the workspace's id, random, made
            // here once, which the workspace manifest names. Only adds:
            // the previous release ignores the new table and the nullable
            // column, and its sessions carry no device.
            version: 8,
            name: 'devices',
            phase: 'expand',
            up: `CREATE TABLE auth_device(id TEXT PRIMARY KEY, installIdHash TEXT UNIQUE, userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, label TEXT NOT NULL, platform TEXT CHECK(platform IN ('ios','android')), variant TEXT CHECK(variant IN ('production','preview','development')), state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked','revoked_and_erase')), pushEndpoint TEXT, createdAt INTEGER NOT NULL, lastSeenAt INTEGER, endedAt INTEGER, sessionExpiresAt INTEGER);
CREATE INDEX auth_device_userId_idx ON auth_device(userId);
ALTER TABLE "auth_session" ADD COLUMN "deviceId" text;
CREATE INDEX auth_session_deviceId_idx ON auth_session(deviceId);
CREATE TABLE auth_workspace(id TEXT PRIMARY KEY, one INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(one = 1), createdAt INTEGER NOT NULL);
INSERT INTO auth_workspace(id, createdAt) VALUES ('w_' || lower(hex(randomblob(16))), CAST(unixepoch('subsec') * 1000 AS INTEGER));`,
        },
        {
            // CB-352: the app's sign-in sheet. A request the app
            // started (its PKCE challenge, state, platform and build), then,
            // once the web approves it, the code's SHA-256 (never the code),
            // who approved it from which session and how that session began,
            // and when the code was used. Only adds a table.
            version: 9,
            name: 'device sign-in requests',
            phase: 'expand',
            up: `CREATE TABLE auth_device_request(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, state TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('ios','android')), variant TEXT NOT NULL CHECK(variant IN ('production','preview','development')), createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, codeHash TEXT UNIQUE, codeExpiresAt INTEGER, userId TEXT REFERENCES auth_user(id) ON DELETE CASCADE, sessionId TEXT, signInMethod TEXT, usedAt INTEGER);
CREATE INDEX auth_device_request_userId_idx ON auth_device_request(userId);`,
        },
        {
            // CB-352: Add a device. A QR code's pairing code (its
            // SHA-256), the web session that made it and how it began; the claim
            // it became (the device's PKCE challenge, label, platform and build,
            // and the HMAC of the 6 digits the server made, never the digits),
            // the page's last poll, wrong tries, and how it ended. Only adds.
            version: 10,
            name: 'add a device',
            phase: 'expand',
            up: `CREATE TABLE auth_device_pairing(id TEXT PRIMARY KEY, codeHash TEXT NOT NULL UNIQUE, userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, sessionId TEXT NOT NULL, signInMethod TEXT NOT NULL, variant TEXT NOT NULL CHECK(variant IN ('production','preview','development')), createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, claimId TEXT UNIQUE, challenge TEXT, label TEXT, platform TEXT CHECK(platform IN ('ios','android')), claimVariant TEXT, digitsMac TEXT, claimedAt INTEGER, claimExpiresAt INTEGER, lastPolledAt INTEGER, tries INTEGER NOT NULL DEFAULT 0, allowedAt INTEGER, deniedAt INTEGER, usedAt INTEGER, redeemedAt INTEGER);
CREATE INDEX auth_device_pairing_userId_idx ON auth_device_pairing(userId);
CREATE INDEX auth_device_pairing_sessionId_idx ON auth_device_pairing(sessionId);`,
        },
        {
            // CB-352: sign-in codes the app asks for. One row per
            // request, whatever the email (the address itself is never stored):
            // the app's PKCE challenge, platform and build, the code's SHA-256,
            // the account, how the code went (link or link:email) and a hash of
            // who it went to (the redeem needs the same one) once sent,
            // and the tries, counted here so a restart doesn't reset them.
            version: 11,
            name: 'sign-in codes',
            phase: 'expand',
            up: `CREATE TABLE auth_device_code(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('ios','android')), variant TEXT NOT NULL CHECK(variant IN ('production','preview','development')), codeHash TEXT NOT NULL, userId TEXT REFERENCES auth_user(id) ON DELETE CASCADE, signInMethod TEXT, recipient TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, usedAt INTEGER);
CREATE INDEX auth_device_code_userId_idx ON auth_device_code(userId);`,
        },
        {
            // CB-352 (hardening): the start URL's challenge and state can
            // leak through access logs. Each may start one request only, so a
            // copied one can't start another (the victim's row is always first);
            // and the approval belongs to the browser that started the request
            // (a hash of its cookie), so a leaked request id can't be approved
            // elsewhere. Later duplicates (a retried start URL, or a copy) go first,
            // even live ones: the first request is the one kept. Rows
            // are kept 30 days now, so createdAt gets an index for the cleanup.
            version: 12,
            name: 'sheet requests: unique and bound to their browser',
            phase: 'expand',
            compatible:
                'The app makes a fresh challenge and state for every sheet sign-in; a duplicate is a retried start URL or a copy. The delete keeps the first request and drops later ones even if still live, so a retried start on the previous release must be started again in the app. The new column is nullable and the previous release never reads it.',
            up: `DELETE FROM auth_device_request WHERE rowid NOT IN (SELECT min(rowid) FROM auth_device_request GROUP BY challenge);
DELETE FROM auth_device_request WHERE rowid NOT IN (SELECT min(rowid) FROM auth_device_request GROUP BY state);
CREATE UNIQUE INDEX auth_device_request_challenge_uq ON auth_device_request(challenge);
CREATE UNIQUE INDEX auth_device_request_state_uq ON auth_device_request(state);
ALTER TABLE auth_device_request ADD COLUMN browserHash TEXT;
CREATE INDEX auth_device_request_createdAt_idx ON auth_device_request(createdAt);`,
        },
        {
            // CB-352: which channel each sign-in link went by (a
            // SHA-256 of its token), so an emailed link signs in as
            // `link:email` under the access policy's email key. Kept as long as
            // the link lives; a link sent before this went by Telegram.
            version: 13,
            name: 'sign-in link channels',
            phase: 'expand',
            up: `CREATE TABLE auth_link_via(tokenHash TEXT PRIMARY KEY, via TEXT NOT NULL CHECK(via IN ('telegram','email')), expiresAt INTEGER NOT NULL);`,
        },
        {
            // CB-352: push endpoints a device no longer holds whose
            // subscriptions are still to be removed (a replaced one, or one
            // refused while its device signed out), until that succeeds.
            version: 14,
            name: 'push endpoints to clean up',
            phase: 'expand',
            up: `CREATE TABLE auth_device_push_leftover(userId TEXT NOT NULL, endpoint TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(userId, endpoint));`,
        },
        {
            // CB-379: one person's device endings and push changes take turns
            // across processes (account-turns.ts): the lease of the one in its
            // turn, which runs out unless renewed. The previous release takes
            // none and ignores the table.
            version: 15,
            name: 'device turns across processes',
            phase: 'expand',
            up: `CREATE TABLE auth_device_turn(accountId TEXT PRIMARY KEY, holder TEXT NOT NULL, expiresAt INTEGER NOT NULL);`,
        },
        {
            // CB-390: the operator role is retired and the workspace
            // gets one owner. Expand only, under a start-first deploy: the
            // previous release keeps serving on the result, and it still keeps
            // its admins off an operator's account. So the stored `operator`
            // values stay as they are: this release reads each as `admin`
            // (`normalizeRole`), and a later release's contract migration
            // rewrites them once no build that knows the role runs. Each former
            // operator gets a workspace audit line now. The owner is the
            // earliest-created active admin or operator that is a person (not a
            // service account), audited too; whatever the previous release does
            // meanwhile, this release's own guards apply to that account from
            // its first request.
            version: 16,
            name: 'retire the operator role; the workspace owner',
            phase: 'expand',
            // A function, so a database without the workspace's tables (a
            // test that migrates auth alone) still gets the table.
            up: (db) => {
                db.exec(
                    'CREATE TABLE auth_workspace_owner(id INTEGER PRIMARY KEY CHECK(id = 1), accountId TEXT NOT NULL, since INTEGER NOT NULL)',
                );
                const has = (table: string) =>
                    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
                const audit = has('workspace_audit');
                if (audit) {
                    db.exec(
                        `INSERT INTO workspace_audit(actor, action, targetKind, targetId, detail, createdAt) SELECT 'system', 'update', 'user', COALESCE("appUserId", "id"), 'operator role retired; now admin', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM "auth_user" WHERE "role" = 'operator'`,
                    );
                }
                const service = has('service_accounts')
                    ? ` AND (u."appUserId" IS NULL OR u."appUserId" NOT IN (SELECT userId FROM service_accounts))`
                    : '';
                db.exec(
                    `INSERT INTO auth_workspace_owner(id, accountId, since) SELECT 1, u."id", CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM "auth_user" u WHERE u."role" IN ('admin', 'operator') AND COALESCE(u."banned", 0) = 0${service} ORDER BY u."createdAt", u."id" LIMIT 1`,
                );
                if (audit) {
                    db.exec(
                        `INSERT INTO workspace_audit(actor, action, targetKind, targetId, detail, createdAt) SELECT 'system', 'create', 'workspace_owner', COALESCE(u."appUserId", u."id"), 'workspace owner: the earliest-created active admin', o.since FROM auth_workspace_owner o JOIN "auth_user" u ON u."id" = o.accountId`,
                    );
                }
            },
        },
        {
            // CB-570: the Socio app's native Google and Apple sign-in. The
            // nonces this server issues (their SHA-256, never the nonce),
            // each for one provider and purpose, a link's bound to the
            // session that asked, single use and short-lived. A link is a
            // Better Auth account row (`google-native` or `apple-native`, the
            // provider's subject as `accountId`), one per subject: the index
            // makes a second link of one subject fail, whichever runtime
            // tries. `linkEmail` is the token's email at link time, shown
            // to the person only and never used to find an account. Only
            // adds: the previous release ignores the table, the column and
            // the rows.
            version: 17,
            name: 'native google and apple sign-in',
            phase: 'expand',
            compatible:
                'The unique index covers only google-native and apple-native rows, which no earlier release writes and no generic provider can use (its ids are refused); the table is new and the column nullable.',
            up: `CREATE TABLE auth_social_nonce(nonceHash TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('google','apple')), purpose TEXT NOT NULL CHECK(purpose IN ('signin','link')), sessionId TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER);
CREATE INDEX auth_social_nonce_expiresAt_idx ON auth_social_nonce(expiresAt);
ALTER TABLE "auth_account" ADD COLUMN "linkEmail" text;
CREATE UNIQUE INDEX auth_account_native_uq ON auth_account(providerId, accountId) WHERE providerId IN ('google-native', 'apple-native');`,
        },
        {
            // Google and Apple sign-in and linking on the website, through
            // Socio's sign-in page. Its nonces live apart from the app's:
            // version 17's purpose check allows only the app's purposes, and
            // a table can't change its checks without being rebuilt. A row
            // holds the nonce's SHA-256, the SHA-256 of the browser's binding
            // cookie, where to go after (a same-origin path), and for a link
            // the session that asked, and when its one redeem began (a flow
            // gets one call to the cloud, whatever it answers). Only adds: the previous release
            // ignores the table.
            version: 18,
            name: 'website google and apple sign-in',
            phase: 'expand',
            up: `CREATE TABLE auth_social_web_nonce(nonceHash TEXT PRIMARY KEY, bindHash TEXT NOT NULL UNIQUE, provider TEXT NOT NULL CHECK(provider IN ('google','apple')), purpose TEXT NOT NULL CHECK(purpose IN ('web-signin','web-link')), sessionId TEXT, next TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, redeemStartedAt INTEGER, usedAt INTEGER);
CREATE INDEX auth_social_web_nonce_expiresAt_idx ON auth_social_web_nonce(expiresAt);`,
        },
    ],
};
