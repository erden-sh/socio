/** Page navigation only follows records from the current Space's authorized list. */
export interface HierarchyPage {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
}

/** Reuse one scoped index when rendering a whole library. */
export function pageHierarchy(pages: readonly HierarchyPage[], spaceId: string) {
    const index = new Map<string, HierarchyPage>();
    const ambiguous = new Set<string>();
    for (const item of pages) {
        if (item.spaceId !== spaceId) {
            continue;
        }
        if (index.has(item.id)) {
            ambiguous.add(item.id);
        }
        index.set(item.id, item);
    }
    const cache = new Map<HierarchyPage, { ancestors: HierarchyPage[]; cycle: boolean }>();
    const lineage = (page: HierarchyPage) => {
        const cached = cache.get(page);
        if (cached) {
            return cached;
        }
        const ancestors: HierarchyPage[] = [];
        const seen = new Set([page.id]);
        let parentId = page.parentId;
        let cycle = false;
        let complete = page.spaceId === spaceId;
        while (parentId && complete) {
            if (seen.has(parentId)) {
                cycle = true;
                break;
            }
            seen.add(parentId);
            const parent = ambiguous.has(parentId) ? undefined : index.get(parentId);
            // A partial loader, orphan or inaccessible parent cannot invent a trail.
            if (!parent) {
                complete = false;
                break;
            }
            ancestors.push(parent);
            parentId = parent.parentId;
        }
        const result = {
            ancestors: complete && !cycle ? ancestors.reverse() : [],
            cycle,
        };
        cache.set(page, result);
        return result;
    };
    return {
        /** Root first; never includes this page, missing records or a cyclic trail. */
        ancestors: (page: HierarchyPage) => lineage(page).ancestors,
        /** Direct children only, preserving list order; invalid self/cycle edges stay hidden. */
        children: (page: HierarchyPage) => {
            if (page.spaceId !== spaceId || lineage(page).cycle) {
                return [];
            }
            const seen = new Set([page.id]);
            return pages.filter((item) => {
                if (item.spaceId !== spaceId || item.parentId !== page.id || seen.has(item.id)) {
                    return false;
                }
                seen.add(item.id);
                return true;
            });
        },
    };
}
export const pageAncestors = (page: HierarchyPage, pages: readonly HierarchyPage[]) =>
    pageHierarchy(pages, page.spaceId).ancestors(page);
export const pageChildren = (page: HierarchyPage, pages: readonly HierarchyPage[]) =>
    pageHierarchy(pages, page.spaceId).children(page);
