import type { DatabaseSync } from 'node:sqlite';

/**
 * The operator role is retired (CB-390). Stored `operator` values stay until a
 * later release's contract migration: the previous release may still be serving
 * on this database (start-first deploy), and it keeps its admins off an
 * operator's account. This release reads each as `admin` (`normalizeRole`).
 *
 * This boot step keeps feature-flag rules that name `operator` reaching
 * the former operators: it adds `admin` beside it, so this release (which
 * reads only `admin` and `member`) and the previous one (which still sees
 * `operator`) both match them. The table is the flags module's; it may not
 * exist yet on a new database. Idempotent. Returns lines for the log.
 */
export function retireOperatorRows(db: DatabaseSync): string[] {
    const flagRules = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flag_rules'`).get();
    if (!flagRules) {
        return [];
    }
    const rules = db.prepare(`SELECT rowid AS id, roles FROM flag_rules WHERE roles LIKE '%"operator"%'`).all() as {
        id: number;
        roles: string;
    }[];
    const update = db.prepare('UPDATE flag_rules SET roles = ? WHERE rowid = ?');
    let rewritten = 0;
    for (const rule of rules) {
        let roles: unknown;
        try {
            roles = JSON.parse(rule.roles);
        } catch {
            continue;
        }
        if (!Array.isArray(roles) || !roles.includes('operator') || roles.includes('admin')) {
            continue;
        }
        update.run(JSON.stringify([...roles, 'admin']), rule.id);
        rewritten++;
    }
    return rewritten ? [`Flags: ${rewritten} rule(s) for the retired operator role now name admins too.`] : [];
}
