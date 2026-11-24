import activity from './activity/routes';
import agents from './agents/routes';
import approvals from './approvals/routes';
import apps from './apps/routes';
import chat from './chat/routes';
import data from './dataspace/routes';
import dots from './dots/routes';
import issues from './issues/routes';
import learning from './learning/routes';
import media from './media/routes';
import memories from './memories/routes';
import operations from './operations/routes';
import operator from './operator/routes';
import plugins from './plugins/routes';
import runs from './runs/routes';
import schedules from './schedules/routes';
import settings from './settings/routes';
import spaces from './spaces/routes';

/**
 * The pages of every module that has some, one line each. A module's
 * `routes.ts` is a layout on its `gate.route.tsx`, with the id
 * `module:<id>`. Route config files import nothing but
 * `@react-router/dev/routes`: React Router reads them in Node to build the
 * route table, where the manifests' components can't load.
 */
export const moduleRoutes = [
    chat,
    spaces,
    activity,
    memories,
    data,
    media,
    approvals,
    apps,
    schedules,
    plugins,
    learning,
    issues,
    runs,
    dots,
    agents,
    settings,
    operations,
    operator,
];
