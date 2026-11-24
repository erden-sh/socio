import type { StaticScreenProps } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import type { Edge } from 'react-native-safe-area-context';

import { useCollections, useHasWorkspaceScope, useLiveQuery } from '../live';
import { BackButton } from '../navigation/header-bar';
import { newChatView } from '../shell/first-run';
import { shellQuery, shellRows, sociosQuery } from '../shell/queries';

import { FirstRun } from './first-run';

// New chat at any time (ChatGPT's and T3 Code's always-there new chat): the `NewChat` route at the web's
// `/dots/:socioId/new`, pushed from Home's New chat, a socio row's new-chat
// button and the Chats tab's compose button. It is the first run's screen
// (first-run.tsx): the socio picker at the top, opening on the socio
// asked for, the privacy line, the model picker by the composer and the
// composer, which sends the socio's new-chat box as a new chat
// (`enqueueNewChat`) with the chosen model in its create. The new chat replaces this
// screen, so Back from it goes where New chat was opened.

const PAGE_EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left'];

export function NewChatScreen({ route }: StaticScreenProps<{ socioId: string }>) {
    return useHasWorkspaceScope() ? <NewChat socioId={route.params.socioId} /> : null;
}

function NewChat({ socioId }: { socioId: string }) {
    const navigation = useNavigation();
    const collections = useCollections();
    const [picked, setPicked] = useState(socioId);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { state, workspace } = shellRows(shell);
    const view = newChatView({ dots, state, workspace, picked });
    if (view === null) {
        return null;
    }
    return (
        <FirstRun
            view={view}
            pick={setPicked}
            edges={PAGE_EDGES}
            replace
            testID="new-chat"
            leading={navigation.canGoBack() ? <BackButton onPress={navigation.goBack} /> : null}
        />
    );
}
