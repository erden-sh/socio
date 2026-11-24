import { useParams } from 'react-router';

import { DotAdminDetailPage, DotsAdminPage } from './DotsAdminPage';

/** `/admin/dots` and `/admin/dots/:dotId` (admins; the gate sends members home). */
export default function DotsAdminRoute() {
    const { dotId } = useParams();
    return dotId ? <DotAdminDetailPage dotId={dotId} /> : <DotsAdminPage />;
}
