import { and, eq } from 'drizzle-orm';

import type { FlagScope } from '../../contract.js';
import type { FlagRuleRepository, StoredFlagRule } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { flagRules } from './schema.js';

/** Hard deletes name the table (tests/hard-deletes.test.ts). */
const r = flagRules;

/** Operators' and admins' rules; clearing one deletes its row. */
export class SqliteFlagRules extends SqliteRepository implements FlagRuleRepository {
    save(rule: StoredFlagRule) {
        return this.write('save flag rule', async () => {
            await this.db
                .insert(r)
                .values(rule)
                .onConflictDoUpdate({
                    target: [r.scope, r.scopeId, r.flag],
                    set: {
                        enabled: rule.enabled,
                        roles: rule.roles,
                        people: rule.people,
                        locked: rule.locked,
                        updatedBy: rule.updatedBy,
                        updatedAt: rule.updatedAt,
                    },
                });
        });
    }

    clear(scope: FlagScope, scopeId: string, flag: string) {
        return this.write('clear flag rule', async () => {
            const { changes } = await this.db
                .delete(flagRules)
                .where(and(eq(r.scope, scope), eq(r.scopeId, scopeId), eq(r.flag, flag)));
            return Number(changes) > 0;
        });
    }
}
