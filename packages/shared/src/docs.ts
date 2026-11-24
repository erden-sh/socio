import type { Root } from 'hast';

/** Plain data only: no content module ever enters the browser build. */
export interface DocsPage {
    url: string;
    title: string;
    description: string;
    body: Root;
    toc: { title: string; url: string; depth: number }[];
}
export interface DocsTree {
    name: string;
    children: {
        type: 'folder';
        name: string;
        children: { type: 'page'; name: string; url: string }[];
    }[];
}
export interface DocsScreen {
    page: DocsPage;
    tree: DocsTree;
}
