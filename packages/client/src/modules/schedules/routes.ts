import { layout, route } from '@react-router/dev/routes';

export default layout('modules/schedules/gate.route.tsx', { id: 'module:schedules' }, [
    route('schedules', 'modules/schedules/SchedulesPage.route.tsx', {
        id: 'schedules',
    }),
    route('schedules/:scheduleId', 'modules/schedules/SchedulePage.route.tsx', {
        id: 'schedules:schedule',
    }),
]);
