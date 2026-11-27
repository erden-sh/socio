import { lazy, Suspense, type ComponentProps } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { Dot } from '@socio/shared/types';

import { useOnDemand } from '../../i18n/on-demand';
import { ClientOnly } from '../../lib/client-only';
import { importOrReload } from '../../shell/chunk-reload';

import type { Chat as ChatView } from './Chat';
import { ChatFrame, ChatHeader, type ChatPlacement } from './chat-chrome';
import { CHAT_NAMESPACES } from './live-namespaces';

// Loaded on demand, in the browser only: the server never runs CopilotKit's
// chat, the agent connection or the call.
const Chat = lazy(() =>
    importOrReload(() => import('./ChatRuntime')).then((module) => ({
        default: module.ChatRuntime,
    })),
);

/**
 * The chat's own first state (its header, connecting), while its code
 * loads and on the server: the same box, so nothing shifts.
 */
function ChatLoading({ dot, paused, placement }: { dot: Dot; paused: boolean; placement?: ChatPlacement }) {
    const { t } = useTranslation(['chat.nav']);
    return (
        <ChatFrame placement={placement} aria-busy="true">
            <ChatHeader
                placement={placement}
                identity={dot.id}
                mascotCharacter={dot.character}
                mascotName={dot.name}
                mascotState={paused ? 'paused' : 'idle'}
                title={dot.name}
                status={paused ? t('chat.nav:loading.paused') : t('chat.nav:loading.connecting')}
            />
        </ChatFrame>
    );
}

/** A conversation's live chat (`Chat`), rendered in the browser only. */
export function ClientChat(props: ComponentProps<typeof ChatView>) {
    const ready = useOnDemand([...CHAT_NAMESPACES]);
    const loading = <ChatLoading dot={props.dot} paused={props.paused} placement={props.placement} />;
    if (!ready) {
        return loading;
    }
    return (
        <ClientOnly fallback={loading}>
            {() => (
                <Suspense fallback={loading}>
                    <Chat {...props} />
                </Suspense>
            )}
        </ClientOnly>
    );
}
