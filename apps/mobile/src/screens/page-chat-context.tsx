import { useNavigation, useNavigationState } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useWorkspaceScope } from '../live';
import { pageAction } from '../navigation/tabs';
import {
    PAGE_CONTEXT_HINT,
    PAGE_CONTEXT_LEAD,
    pageContextLabel,
    pageContextTap,
    type StackRoute,
} from '../shell/page-conversation';
import type { PageChatContext } from '../sync/page-conversation';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Text } from '../ui';

// A page chat's page (CB-499; the web's `page-chat-context` in Chat.tsx): the
// chat screen asks the scope's `pageChats` which page the chat is about
// (`GET …/page-context`, once while the scope is open) and shows it under the
// bar, the web's strip in the brand's 10% tint, "Working on" and the page's
// title, which goes back to the page (or opens it). While a page chat shows, a
// turn's end pulls the page's Space (`usePageRefreshAfterTurn`): its tree, and
// the page's body under the chat once its revision moved (the store's rule), so
// what the socio wrote or the subpages it made are there on the way back, as the
// web's `onSaved` refreshes the page.

/** The page a chat is about: the page, null for a chat about none, undefined while it isn't known. */
export function usePageChatContext(chatId: string | null): PageChatContext | null | undefined {
    const { pageChats } = useWorkspaceScope();
    const [page, setPage] = useState(() => (chatId === null ? null : pageChats.known(chatId)));
    useEffect(() => {
        if (chatId === null) {
            setPage(null);
            return undefined;
        }
        let active = true;
        setPage(pageChats.known(chatId));
        pageChats
            .context(chatId)
            .then((next) => {
                if (active) {
                    setPage(next);
                }
            })
            .catch(() => {});
        return () => {
            active = false;
        };
    }, [pageChats, chatId]);
    return page;
}

/** After each turn of a page chat: the page's Space pulled, so the page and its tree show the socio's changes. */
export function usePageRefreshAfterTurn(page: PageChatContext | null | undefined, running: boolean) {
    const { pages } = useWorkspaceScope();
    const was = useRef(running);
    const spaceId = page?.spaceId ?? null;
    useEffect(() => {
        const ended = was.current && !running;
        was.current = running;
        if (ended && spaceId !== null) {
            pages
                .space(spaceId)
                .pull()
                .catch((error: unknown) => console.warn('[pages] the page chat’s Space did not refresh', error));
        }
    }, [pages, spaceId, running]);
}

/**
 * The strip under the bar: "Working on <title>", the title back to the page. The web's title is the
 * brand teal; here the chat's link teal, the brand's darker step, since the brand is under 4.5:1 on
 * its tint at this size in light (CB-219, room-parts.tsx's MentionedYou).
 */
export function PageContextBanner({ page, onLayout }: { page: PageChatContext; onLayout?: (height: number) => void }) {
    const navigation = useNavigation();
    const link = colorsOf(useScheme())['chat-link'];
    const routes = useNavigationState((state) => state.routes as readonly StackRoute[]);
    const index = useNavigationState((state) => state.index);
    const open = () => {
        if (pageContextTap(routes, index, page) === 'back') {
            navigation.goBack();
        } else {
            navigation.dispatch(pageAction(page.spaceId, page.id));
        }
    };
    return (
        <View
            className="bg-screen"
            testID="chat-page-context"
            onLayout={(event) => onLayout?.(event.nativeEvent.layout.height)}
        >
            <Pressable
                accessibilityRole="link"
                accessibilityLabel={pageContextLabel(page)}
                accessibilityHint={PAGE_CONTEXT_HINT}
                onPress={open}
                className="min-h-11 flex-row items-center bg-brand/10 px-5 py-2.5 active:bg-brand/20"
                testID="chat-page-context-open"
            >
                <Text variant="footnote" numberOfLines={1} className="flex-1">
                    {`${PAGE_CONTEXT_LEAD} `}
                    <Text variant="footnote" weight="medium" style={{ color: link, textDecorationLine: 'underline' }}>
                        {page.title}
                    </Text>
                </Text>
            </Pressable>
        </View>
    );
}
