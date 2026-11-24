import { createContext, useContext } from 'react';

/** The page a dataset view block is on: the Space decides who sees its data. */
export interface DatasetViewPage {
    spaceId: string;
    pageId: string;
}
export const DatasetViewContext = createContext<DatasetViewPage | null>(null);
export const useDatasetViewPage = () => useContext(DatasetViewContext);
