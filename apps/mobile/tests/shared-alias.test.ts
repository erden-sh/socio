import { describe, expect, it } from 'vitest';

import { NO_INFERENCE_MESSAGES } from '@socio/shared/inference';
import { modelChoiceInput } from '@socio/shared/inference/model-choice-input';
import * as rooms from '@socio/shared/rooms/rooms';
import { formatTokens } from '@socio/shared/token-count';

import * as roomsSource from '../../../packages/shared/src/rooms/rooms.ts';

// vitest.config.mts maps @socio/shared/<path> to packages/shared/src/<path>, as
// metro.config.js does for the bundle. Without it these imports would go through
// shared's exports to dist/, which a fresh checkout and CI don't have.
describe('@socio/shared in the app’s tests', () => {
    it('gives runtime values from shared’s source', () => {
        expect(rooms.ROOM_UNREAD_CAP).toBe(100);
        expect(NO_INFERENCE_MESSAGES.operator).toMatch(/^No model is available/);
        // The very module the source path loads, not a built copy.
        expect(rooms).toBe(roomsSource);
    });

    it('follows shared’s relative `.js` imports to their `.ts` files', () => {
        // token-count.ts imports numberFormat from './locale.js'.
        expect(formatTokens(1_360_000)).toBe('1.36M');
    });

    it('resolves shared’s own dependencies from packages/shared', () => {
        expect(modelChoiceInput.safeParse({ source: 'shared', backendId: 'b1' }).success).toBe(true);
        expect(modelChoiceInput.safeParse({ source: 'nope' }).success).toBe(false);
    });
});
