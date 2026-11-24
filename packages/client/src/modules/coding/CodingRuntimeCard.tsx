import { type CodingRuntimeCard } from '@socio/shared/coding/coding-sessions';
import { inertText } from '@socio/shared/text/inert-text';

/**
 * A runtime-request approval's card body (CB-326 step 4): the socio's name
 * and repository, the kind of approval, and the exact command or change in
 * monospace — modelled on T3's approvals. Everything the agent wrote is shown
 * as plain text, never Markdown or links.
 */
export function CodingRuntimeBody({ card }: { card: CodingRuntimeCard }) {
    const socioName = inertText(card.socioName, { max: 80, lines: false });
    const action = inertText(card.action, { max: 2000 });
    return (
        <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
                {socioName} asks: {card.kindLabel} on {card.repository}
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{action}</pre>
        </div>
    );
}
