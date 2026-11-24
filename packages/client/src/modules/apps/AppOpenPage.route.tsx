import type { RouteHandle } from '../../shell/shell-context';

export { AppOpenPage as default } from './AppOpenPage';
export const handle: RouteHandle = {
    crumb: () => [{ label: 'Apps', to: '/apps' }, { label: 'Open' }],
};
