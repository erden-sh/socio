import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import { useContext, type ComponentProps } from 'react';

import { CurrentUser } from '../../shell/current-user';

import { Chat } from './Chat';
import { copilotKitOptions } from './copilotkit-options';

/** Loaded only by ClientChat: ordinary pages never initialize the chat SDK. */
export function ChatRuntime(props: ComponentProps<typeof Chat>) {
    const user = useContext(CurrentUser);
    return (
        <CopilotKitProvider key={user?.id} {...copilotKitOptions}>
            <Chat {...props} />
        </CopilotKitProvider>
    );
}
