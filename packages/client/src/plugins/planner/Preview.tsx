/**
 * X post preview. The card frame comes from `@socio/plugin-ui` (adapted
 * from vercel/react-tweet, MIT). This file is the planner's text: link
 * styling and the reminder that nothing is sent to X.
 */
import { PreviewCard } from '@socio/plugin-ui';
import { formatZonedLabel } from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

const TOKEN = /(https?:\/\/\S+|www\.\S+|@\w+|#\w+)/g;
const IS_TOKEN = /^(?:https?:\/\/\S+|www\.\S+|@\w+|#\w+)$/;

export function PostPreview({
    account,
    parts,
    plannedAt,
}: {
    account: string;
    parts: ThreadPart[];
    plannedAt?: number;
}) {
    const handle = account || 'account';
    const shown = parts.length ? parts : [{ text: '' }];
    return (
        <div className="grid gap-3" aria-label="Post preview">
            <p className="sr-only">Preview only. Nothing here is sent to X.</p>
            {shown.map((part, index) => (
                <PreviewCard
                    key={index}
                    name={handle}
                    handle={`@${handle}`}
                    thread={index > 0}
                    time={`${plannedAt ? formatZonedLabel(plannedAt) : 'Unscheduled'}${
                        shown.length > 1 ? ` · ${index + 1}/${shown.length}` : ''
                    }`}
                >
                    <TweetText text={part.text.trim() || 'Your post will show up here.'} />
                </PreviewCard>
            ))}
        </div>
    );
}

function TweetText({ text }: { text: string }) {
    const bits = text.split(TOKEN);
    return (
        <p className="tweet-text">
            {bits.map((bit, index) =>
                IS_TOKEN.test(bit) ? (
                    <span key={index} className="tweet-link">
                        {bit}
                    </span>
                ) : (
                    <span key={index}>{bit}</span>
                ),
            )}
        </p>
    );
}
