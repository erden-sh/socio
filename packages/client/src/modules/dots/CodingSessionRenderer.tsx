import { useRenderTool } from '@copilotkit/react-core/v2';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { CODING_CARD_TOOLS, CODING_PRIVATE_LINE } from '@socio/shared/coding/coding-sessions';
import type { CodingSessionView } from '@socio/shared/coding/coding-sessions';

import { api } from '../../lib/api';
import { CodingSessionPanel } from '../coding/CodingSessionCard';
import type { ToolRenderProps } from '../types';

/**
 * The coding session card (CB-239) for the `coding_*` tools whose
 * results name a session: while the tool runs, the card of the session it
 * names (or this conversation's running one), whose progress updates as
 * the agent works; once it answers, the session's card, or the refusal.
 */

const parameters = z.object({ session: z.string().optional() }).passthrough();

/** The session id a tool result names, if any. */
export function resultSession(result: unknown): string | undefined {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    const session = value && typeof value === 'object' ? (value as { session?: unknown }).session : undefined;
    const id = session && typeof session === 'object' ? (session as { id?: unknown }).id : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** A refusal's words, if the result is one. */
function refusal(result: unknown): string | undefined {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    const record = value && typeof value === 'object' ? (value as { status?: unknown; error?: unknown }) : {};
    return record.status === 'refused' && typeof record.error === 'string' ? record.error : undefined;
}

/**
 * Whether a result is one the server withheld (a room turn for someone
 * else, CB-210 `withheldResult`): its session is that person's alone, so
 * everyone else gets the neutral line (CB-239).
 */
export function withheldResult(result: unknown): boolean {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return false;
        }
    }
    return !!value && typeof value === 'object' && (value as { withheld?: unknown }).withheld === true;
}

/** The neutral line others see of a coding session's result in a room. */
export function PrivateCodingLine() {
    return (
        <p className="m-0 text-sm text-muted-foreground" data-slot="coding-session-private">
            {CODING_PRIVATE_LINE}
        </p>
    );
}

/** This conversation's running session, while a tool that names none runs. */
function RunningSession({ threadId }: { threadId: string }) {
    const [id, setId] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        void api<{ sessions: Array<CodingSessionView & { threadId?: string }> }>(
            `/gateway/sessions?thread=${encodeURIComponent(threadId)}`,
            'GET',
            undefined,
            controller.signal,
        ).then(
            ({ sessions }) => setId(sessions.find((session) => session.state !== 'ended')?.id ?? null),
            () => undefined,
        );
        return () => controller.abort();
    }, [threadId]);
    return id ? (
        <CodingSessionPanel id={id} />
    ) : (
        <p className="m-0 text-sm text-muted-foreground" role="status">
            Working on the coding session…
        </p>
    );
}

function OneTool({ name, threadId }: { name: string; threadId: string }) {
    useRenderTool(
        {
            name,
            parameters,
            render: (props) => {
                if (props.status !== 'complete') {
                    const named = props.status === 'executing' ? props.parameters.session : undefined;
                    return named && /^[A-Za-z0-9_-]{1,64}$/.test(named) ? (
                        <CodingSessionPanel id={named} />
                    ) : (
                        <RunningSession threadId={threadId} />
                    );
                }
                if (withheldResult(props.result)) {
                    return <PrivateCodingLine />;
                }
                const id = resultSession(props.result);
                if (id) {
                    return <CodingSessionPanel id={id} />;
                }
                const refused = refusal(props.result);
                return refused ? <p className="m-0 text-sm text-muted-foreground">{refused}</p> : null;
            },
        },
        [name, threadId],
    );
    return null;
}

/** Registers the card for each tool; shows nothing itself. */
export function CodingSessionRenderer({ threadId }: ToolRenderProps) {
    return (
        <>
            {CODING_CARD_TOOLS.map((name) => (
                <OneTool key={name} name={name} threadId={threadId} />
            ))}
        </>
    );
}
