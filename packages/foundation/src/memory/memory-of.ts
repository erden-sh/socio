import type { Memory } from '@socio/shared/types';

// Moved from `src/server/memory/domain/rules.ts`.

/** A memory as `/api/state` and research runs give it: its words and when. */
export const memoryOf = ({ id, text, createdAt }: Memory): Memory => ({
    id,
    text,
    createdAt,
});
