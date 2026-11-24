import { ActivityScreen, TaskScreen } from '../screens/activity';
import { ApprovalScreen, ApprovalsScreen } from '../screens/approvals';
import { BoardScreen } from '../screens/board';
import { ChatScreen } from '../screens/chat';
import { DatasetScreen } from '../screens/dataset';
import { DatasetFieldScreen, DatasetFieldsScreen } from '../screens/dataset-fields';
import { DatasetNewRowScreen } from '../screens/dataset-new-row';
import { DatasetPreviewScreen } from '../screens/dataset-preview';
import { DatasetViewScreen } from '../screens/dataset-view';
import { IssueScreen } from '../screens/issue';
import { LearningScreen } from '../screens/learning';
import { MemoriesScreen } from '../screens/memories';
import { MoreItemScreen } from '../screens/more-item';
import { NewChatScreen } from '../screens/new-chat';
import { NotificationsScreen } from '../screens/notifications';
import { PageScreen } from '../screens/page';
import { RunScreen, RunsScreen } from '../screens/runs';
import { JobScreen, ScheduleScreen, SchedulesScreen } from '../screens/schedules';
import { SettingsScreen } from '../screens/settings';
import { SocioScreen } from '../screens/socio';
import { SpaceMemoryScreen, SpaceRadarScreen, SpaceScreen } from '../screens/space';
import { TechnicalDetailsScreen } from '../screens/technical-details';
import { UnsentScreen } from '../screens/unsent-list';

import type { RouteComponent, TabRouteName } from './routes';

// The components of the routes that live in the tabs' own stacks (a
// route with a `tab` in routes.ts), which every tab's stack holds
// (tab-stack.tsx). The root stack's are in root-stack.tsx.
export const TAB_ROUTE_COMPONENTS = {
    Chat: ChatScreen,
    NewChat: NewChatScreen,
    Board: BoardScreen,
    Issue: IssueScreen,
    Memories: MemoriesScreen,
    Activity: ActivityScreen,
    Schedules: SchedulesScreen,
    Schedule: ScheduleScreen,
    Task: TaskScreen,
    Job: JobScreen,
    Learning: LearningScreen,
    Runs: RunsScreen,
    Run: RunScreen,
    Space: SpaceScreen,
    SpaceMemory: SpaceMemoryScreen,
    SpaceRadar: SpaceRadarScreen,
    Page: PageScreen,
    Dataset: DatasetScreen,
    DatasetView: DatasetViewScreen,
    DatasetFields: DatasetFieldsScreen,
    DatasetField: DatasetFieldScreen,
    DatasetNewRow: DatasetNewRowScreen,
    DatasetPreview: DatasetPreviewScreen,
    Socio: SocioScreen,
    Approvals: ApprovalsScreen,
    Approval: ApprovalScreen,
    MoreItem: MoreItemScreen,
    Settings: SettingsScreen,
    Notifications: NotificationsScreen,
    TechnicalDetails: TechnicalDetailsScreen,
    Unsent: UnsentScreen,
} as const satisfies { readonly [Name in TabRouteName]: RouteComponent };
