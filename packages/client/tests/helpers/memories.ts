import type { MemoriesState } from '@socio/shared/memory';
import type { Memory } from '@socio/shared/types';

/** `GET /api/memories` for a person whose memories are all their own (CB-106). */
export const memoriesOf = (memories: readonly Memory[]): MemoriesState => ({
    profile: null,
    proposals: [],
    memories: memories.map((memory) => ({
        ...memory,
        status: 'active',
        source: 'person',
        shareable: false,
        dotId: null,
        threadId: null,
        updatedAt: memory.createdAt,
        confirmedAt: memory.createdAt,
    })),
});
