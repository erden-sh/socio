import { eq } from 'drizzle-orm';

import type { ApprovalNote, ApprovalNoteRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { approvalNotes } from './schema.js';

/** The hidden notes continuation turns start with (CB-58). */
export class SqliteNotes extends SqliteRepository implements ApprovalNoteRepository {
    insert(note: ApprovalNote) {
        return this.write('record approval note', async () => {
            await this.db.insert(approvalNotes).values(note);
        });
    }

    async byId(id: string) {
        return this.db.select().from(approvalNotes).where(eq(approvalNotes.id, id)).get();
    }
}
