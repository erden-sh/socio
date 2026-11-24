import { useHumanInTheLoop } from '@copilotkit/react-core/v2';

import { pageReviewArgsSchema, pageReviewTool } from '@socio/shared/pages/page-review';

import { PageReviewCard } from '../pages/PageReviewCard';
import type { ToolRenderProps } from '../types';

/**
 * The page review (`review_space_page`): the Dot's draft as a card the
 * person approves or declines. Registers with the chat, shows nothing.
 */
export function PageReviewRenderer({ threadId, onSaved }: ToolRenderProps) {
    useHumanInTheLoop(
        {
            name: pageReviewTool.name,
            description: pageReviewTool.description,
            parameters: pageReviewArgsSchema,
            render: (props) => <PageReviewCard {...props} threadId={threadId} onSaved={onSaved} />,
        },
        [threadId, onSaved],
    );
    return null;
}
