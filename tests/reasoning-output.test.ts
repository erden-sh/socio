import { expect, it } from 'vitest';

import { withReasoningOutput, type ReasoningOutputAdapter } from '@socio/shared/reasoning-output';

it('marks the adapter itself with what it shows of its reasoning', () => {
    const adapter = { name: 'model' };
    const marked = withReasoningOutput(adapter, 'summary');
    expect(marked).toBe(adapter);
    expect((marked as ReasoningOutputAdapter).reasoningOutput).toBe('summary');
});
