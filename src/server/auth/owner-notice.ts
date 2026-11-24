import type { OwnerChange } from './contract.js';

/**
 * What every admin is told when the workspace owner changes (CB-390): by the
 * running server (composition/http/auth.ts) and by `auth deactivate` from
 * the server's shell (cli.ts).
 */
export function ownerNotice({ to, from, how }: OwnerChange) {
    return {
        trigger: 'workspace_owner',
        title: 'New workspace owner',
        message:
            how === 'transferred'
                ? `${from?.name ?? 'The previous owner'} made ${to.name} the workspace owner. ${from?.name ?? 'They'} stay an admin.`
                : `${to.name} is now the workspace owner${from ? `: ${from.name} is no longer an active admin` : ''}.`,
        path: '/settings/people',
    };
}
