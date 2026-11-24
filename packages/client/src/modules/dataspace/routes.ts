import { layout, route } from '@react-router/dev/routes';

export default layout('modules/dataspace/gate.route.tsx', { id: 'module:data' }, [
    route('data', 'modules/dataspace/DataPage.route.tsx', { id: 'data' }),
    route('data/datasets/:datasetId', 'modules/dataspace/DatasetPage.route.tsx', { id: 'data:dataset' }),
]);
