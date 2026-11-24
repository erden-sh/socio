import { SOCIO_METADATA } from '@socio/shared/types';

/**
 * Who wrote each answer of a room's conversation, for the model (CB-206):
 * in the order of the messages' answers, `Name (socio)` for one another
 * socio wrote (the runner's `SOCIO_METADATA` stamp, CB-212), undefined
 * for the socio's own and for one stored before replies were stamped.
 * `alternating` (context/alternate.ts) puts each label, `⟦Name (socio)
 * wrote:⟧`, before its answer, as people's messages get theirs (CB-210),
 * so the socio answering knows they were not its own; a label the model
 * echoes is taken off its answer (`speaker-echo.ts`). The stored messages
 * are never changed.
 */
export function answerLabels(
    messages: readonly { role: string; metadata?: unknown }[],
    self: string,
    nameOf: (dotId: string) => string | undefined,
): (string | undefined)[] {
    return messages
        .filter((message) => message.role === 'assistant')
        .map((message) => {
            const metadata = message.metadata as Record<string, unknown> | undefined;
            const dotId = metadata && typeof metadata === 'object' ? metadata[SOCIO_METADATA] : undefined;
            if (typeof dotId !== 'string' || !dotId || dotId === self) {
                return undefined;
            }
            return `${nameOf(dotId) ?? 'Another socio'} (socio)`;
        });
}
