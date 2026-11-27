import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from 'react-native';

import { BUILD_VARIANT } from '../platform/variant';
import { AccountScreen } from '../screens/account';
import { AddDeviceScreen } from '../screens/add-device';
import { AddWorkspaceScreen } from '../screens/add-workspace';
import { ApprovalDetailsScreen } from '../screens/approval-card';
import { AttachmentViewerScreen } from '../screens/attachment-viewer';
import { ChatModelScreen } from '../screens/chat-model';
import { ConfirmWorkspaceScreen } from '../screens/confirm-workspace';
import { DiagnosticsScreen } from '../screens/diagnostics';
import { EditorCorpusScreen } from '../screens/editor-corpus';
import { FileIssueScreen } from '../screens/file-issue';
import { InviteScreen } from '../screens/invite';
import { LockScreen } from '../screens/lock';
import { NewRoomScreen } from '../screens/new-room';
import { NewSpaceScreen } from '../screens/new-space';
import { NotificationAskScreen } from '../screens/notification-ask';
import { PageEditorScreen } from '../screens/page-editor';
import { PageReviewScreen } from '../screens/page-review';
import { PageReviewEditorScreen } from '../screens/page-review-editor';
import { RoomInviteScreen } from '../screens/room-invite';
import { RoomMembersScreen } from '../screens/room-members';
import { RoomMenuScreen } from '../screens/room-menu';
import { RouteSheetScreen } from '../screens/route-sheet';
import { ScanQrScreen } from '../screens/scan-qr';
import { SheetSignInScreen } from '../screens/sheet-sign-in';
import { SignInScreen } from '../screens/sign-in';
import { SignInCodeScreen } from '../screens/sign-in-code';
import { TurnTraceScreen } from '../screens/turn-trace';
import { WorkspaceAddressScreen } from '../screens/workspace-address';
import { hasLiquidGlass } from '../ui/glass';

import { rootState } from './root-gate';
import { staticScreens } from './routes';
import { ScreenBoundary } from './screen-boundary';
import { ShellTabs } from './shell-tabs';

// The root stack: a native stack in React Navigation's static API,
// built from the route table (routes.ts)
// and each root route's component here, for this build's variant (a production
// build has no Diagnostics or EditorCorpus): the tabs, then what shows over
// them (sheets, compose page sheets, the page editor) and the gate's screens.
// The pages pushed inside a tab are in the tabs' own stacks
// (tab-stack.tsx). Every screen sits in its own error boundary.
// A page's bar is the system's (CB-420, presets.ts), its title and buttons in the
// header's own color, as the web's header draws them: the brand's teal stays for
// the page's own actions.
export const RootStack = createNativeStackNavigator({
    screenOptions: ({ theme }) => ({ headerTintColor: theme.colors.text }),
    screenLayout: (props) => <ScreenBoundary {...props} />,
    screens: staticScreens(
        {
            Tabs: ShellTabs,
            FileIssue: FileIssueScreen,
            NewSpace: NewSpaceScreen,
            NewRoom: NewRoomScreen,
            PageEditor: PageEditorScreen,
            Sheet: RouteSheetScreen,
            TallSheet: RouteSheetScreen,
            ChatModel: ChatModelScreen,
            TurnTrace: TurnTraceScreen,
            PageReview: PageReviewScreen,
            PageReviewEditor: PageReviewEditorScreen,
            RoomMembers: RoomMembersScreen,
            RoomMenu: RoomMenuScreen,
            RoomInvite: RoomInviteScreen,
            ApprovalDetails: ApprovalDetailsScreen,
            AttachmentViewer: AttachmentViewerScreen,
            Account: AccountScreen,
            NotificationAsk: NotificationAskScreen,
            AddWorkspace: AddWorkspaceScreen,
            WorkspaceAddress: WorkspaceAddressScreen,
            ScanQr: ScanQrScreen,
            ConfirmWorkspace: ConfirmWorkspaceScreen,
            SignIn: SignInScreen,
            SheetSignIn: SheetSignInScreen,
            SignInCode: SignInCodeScreen,
            AddDevice: AddDeviceScreen,
            Invite: InviteScreen,
            Lock: LockScreen,
            Diagnostics: DiagnosticsScreen,
            EditorCorpus: EditorCorpusScreen,
        },
        BUILD_VARIANT,
        rootState,
        Platform.OS,
        hasLiquidGlass(),
    ),
});

type RootStackType = typeof RootStack;

declare module '@react-navigation/native' {
    // oxlint-disable-next-line typescript/no-empty-object-type -- React Navigation types useNavigation and links from this augmentation
    interface RootNavigator extends RootStackType {}
}
