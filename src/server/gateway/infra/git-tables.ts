import type { Migration } from '@socio/data/migrate';

/**
 * The Git proxy's tables (CB-239, CB-267): version 2 of the
 * gateway module's schema (schema.ts), all new, so an expand migration. Nothing here holds a token or file contents.
 *
 * - `gateway_repositories`: Settings → Coding → Repositories, keyed by the
 *   lowercased `owner/name`. Push needs the confirmed checklist, enforced
 *   by a CHECK as well as the route.
 * - `gateway_git_settings`: the admin's values for the Git proxy's and
 *   extraction's limits, over the environment's.
 * - `gateway_git_mints`: installation tokens minted per hour, counted in
 *   the transaction before each mint, so the instance ceiling holds across
 *   both runtimes of a deploy.
 * - `gateway_extractions`: CB-267's extractions: what was asked, the
 *   approved commit and paths, where the sealed result is and when it was
 *   first read. Counts only; never file names or contents.
 */
export const gatewayGitMigrations: readonly Migration[] = [
    {
        version: 2,
        name: 'coding repositories, git limits, token mints and extractions',
        phase: 'expand',
        up: `CREATE TABLE gateway_repositories(
        key TEXT PRIMARY KEY CHECK(key = lower(key) AND length(key) BETWEEN 3 AND 141),
        repository TEXT NOT NULL,
        baseBranches TEXT NOT NULL DEFAULT '[]',
        branchPrefix TEXT NOT NULL DEFAULT 'socio',
        push INTEGER NOT NULL DEFAULT 0 CHECK(push IN (0, 1)),
        pushChecklistAt INTEGER,
        pushChecklistBy TEXT,
        users TEXT,
        extraction INTEGER NOT NULL DEFAULT 0 CHECK(extraction IN (0, 1)),
        standingExtraction INTEGER NOT NULL DEFAULT 0 CHECK(standingExtraction IN (0, 1)),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL,
        CHECK(push = 0 OR pushChecklistAt IS NOT NULL),
        CHECK(standingExtraction = 0 OR extraction = 1));
      CREATE TABLE gateway_git_settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL);
      CREATE TABLE gateway_git_mints(
        hour INTEGER PRIMARY KEY,
        count INTEGER NOT NULL CHECK(count >= 0));
      CREATE TABLE gateway_extractions(
        id TEXT PRIMARY KEY,
        personId TEXT NOT NULL CHECK(length(personId) > 0),
        socioId TEXT NOT NULL CHECK(length(socioId) > 0),
        appId TEXT NOT NULL CHECK(length(appId) > 0),
        repository TEXT NOT NULL,
        ref TEXT NOT NULL,
        commitId TEXT NOT NULL CHECK(length(commitId) = 40),
        paths TEXT NOT NULL,
        threadId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('requested','running','ready','failed','expired')),
        approvalId TEXT,
        standingGrantId TEXT,
        filePath TEXT,
        files INTEGER,
        bytes INTEGER,
        failure TEXT CHECK(failure IS NULL OR length(failure) <= 300),
        createdAt INTEGER NOT NULL,
        readyAt INTEGER,
        expiresAt INTEGER NOT NULL,
        firstReadAt INTEGER,
        removedAt INTEGER);
      CREATE INDEX gateway_extractions_person ON gateway_extractions(personId, createdAt);
      CREATE INDEX gateway_extractions_live ON gateway_extractions(expiresAt) WHERE removedAt IS NULL;`,
    },
];
