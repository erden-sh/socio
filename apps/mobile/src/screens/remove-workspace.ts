import { Alert } from 'react-native';

import { signOut, unsentItems } from '../platform/sign-out';
import { removeWorkspaceQuestion } from '../shell/workspaces';

// Remove from this device (CB-573): the drawer's long-press menu and Settings'
// row ask the same question (src/shell/workspaces.ts), then sign out of that
// workspace on the phone, as the account sheet's Sign out does
// (platform/sign-out.ts).

/** Asks, then removes workspace `id` from the phone. Cancel, back and a tap outside keep it. */
export async function askThenRemoveWorkspace(id: string, name: string): Promise<void> {
    const question = removeWorkspaceQuestion(name, await unsentItems(id));
    const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
            question.title,
            question.message,
            [
                { text: question.cancel, style: 'cancel', onPress: () => resolve(false) },
                { text: question.confirm, style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
    if (confirmed) {
        await signOut(id);
    }
}
