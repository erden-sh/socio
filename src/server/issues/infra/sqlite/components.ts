import { and, asc, eq, isNull } from 'drizzle-orm';

import type { ComponentRepository, ComponentRow } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { issueComponentNames, issueComponents, issues } from './schema.js';

/** The plugins and apps issues are about (CB-442). */
export class SqliteComponents extends SqliteRepository implements ComponentRepository {
    async forIssue(issueId: string): Promise<ComponentRow[]> {
        return this.db
            .select()
            .from(issueComponents)
            .where(eq(issueComponents.issueId, issueId))
            .orderBy(asc(issueComponents.ref));
    }

    async all(): Promise<ComponentRow[]> {
        return this.db
            .select({
                issueId: issueComponents.issueId,
                ref: issueComponents.ref,
                kind: issueComponents.kind,
                targetId: issueComponents.targetId,
                generation: issueComponents.generation,
                label: issueComponents.label,
                audience: issueComponents.audience,
                addedBy: issueComponents.addedBy,
                addedAt: issueComponents.addedAt,
            })
            .from(issueComponents)
            .innerJoin(issues, and(eq(issues.id, issueComponents.issueId), isNull(issues.deletedAt)))
            .orderBy(asc(issueComponents.issueId), asc(issueComponents.ref));
    }

    replace(issueId: string, rows: readonly ComponentRow[]) {
        return this.write('set issue components', async () => {
            await this.db.delete(issueComponents).where(eq(issueComponents.issueId, issueId));
            for (const row of rows) {
                await this.db.insert(issueComponents).values({ ...row, issueId });
                const name = { label: row.label, audience: row.audience };
                await this.db
                    .insert(issueComponentNames)
                    .values({ issueId, ref: row.ref, ...name })
                    .onConflictDoUpdate({ target: [issueComponentNames.issueId, issueComponentNames.ref], set: name });
            }
        });
    }

    async names(issueId: string) {
        return this.db
            .select({
                ref: issueComponentNames.ref,
                label: issueComponentNames.label,
                audience: issueComponentNames.audience,
            })
            .from(issueComponentNames)
            .where(eq(issueComponentNames.issueId, issueId));
    }
}
