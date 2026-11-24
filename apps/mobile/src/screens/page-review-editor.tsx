import type { StaticScreenProps } from '@react-navigation/native';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { parsePageReviewArgs } from '@socio/shared/pages/page-review';

import { chatSource } from '../chat/chat-source';
import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { reviewDraft } from '../sync/chat-drafts';
import { callArgs } from '../sync/page-review';
import { reviewEditStart } from '../sync/review-edits';

import { EDIT_REVIEW_DRAFT, Editor, Waiting } from './page-editor';

// A page review's editor: the `PageReviewEditor`
// route (no path), from the review sheet's Edit. The page editor
// (page-editor.tsx) in review mode on the socio's draft, or on the edits
// kept from before: its Space stays the draft's, nothing is queued, and its
// text goes to `drafts` under `review:<threadId>:<toolCallId>` (the scope's
// `reviewDrafts`, sync/review-edits.ts). Leaving goes back to the sheet,
// where Save saves the edits.

export function PageReviewEditorScreen({ route }: StaticScreenProps<{ chat: string; call: string; dot: string }>) {
    return useHasWorkspaceScope() ? (
        <ReviewEditor chat={route.params.chat} call={route.params.call} dot={route.params.dot} />
    ) : null;
}

function ReviewEditor({ chat, call, dot }: { chat: string; call: string; dot: string }) {
    const scope = useWorkspaceScope();
    const [source] = useState(() => chatSource(scope.histories.history(chat), scope.follows.follow(chat)));
    useEffect(() => source.history.use(), [source]);
    const snapshot = useSyncExternalStore(source.subscribe, source.get);
    const key = reviewDraft(chat, call);
    const toolCall = snapshot.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
        .find((found) => found.id === call);
    const draft = toolCall === undefined ? null : parsePageReviewArgs(callArgs(toolCall));
    if (draft === null || !draft.success) {
        // Edit is offered only for a draft that reads, so this is a chat that changed meanwhile.
        return <Waiting title={EDIT_REVIEW_DRAFT} line="This review isn’t in the chat any more." />;
    }
    const start = reviewEditStart(scope.reviewDrafts.stored(key), draft.data);
    return <Editor target={{ kind: 'review', chat, call, dot }} open={() => scope.reviewDrafts.open(key, start)} />;
}
