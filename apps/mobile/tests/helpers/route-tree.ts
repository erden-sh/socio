import type { RootStateSource } from '../../src/navigation/root-gate';
import { ROOT_ROUTE_NAMES, staticScreens, staticTabScreens, TAB_ROUTE_NAMES } from '../../src/navigation/routes';
import { staticTabs, TAB_NAMES, tabRootName, tabRootPath, type TabName } from '../../src/navigation/tabs';
import type { VariantName } from '../../variant';

// The app's navigation tree as root-stack.tsx, shell-tabs.tsx and tab-stack.tsx
// build it, with stand-in components: the root stack's routes, the tabs as the
// `Tabs` route's static navigator, and each tab's own stack: its root,
// then every page of the route table with a `tab`.

const blank = () => null;

/** Tab `tab`'s own stack, as tab-stack.tsx builds it. */
export function tabStackTree(tab: TabName, variant: VariantName = 'development', os = 'ios') {
    const pages = staticTabScreens(
        tab,
        Object.fromEntries(TAB_ROUTE_NAMES.map((name) => [name, blank])) as never,
        variant,
        os,
    );
    return {
        config: {
            initialRouteName: tabRootName(tab),
            screens: { [tabRootName(tab)]: { screen: blank, linking: tabRootPath(tab) }, ...pages },
        },
    };
}

/** The tabs, as shell-tabs.tsx builds them. */
export function tabsTree(variant: VariantName = 'development', os = 'ios') {
    return {
        config: {
            screens: staticTabs(
                Object.fromEntries(TAB_NAMES.map((name) => [name, tabStackTree(name, variant, os)])) as never,
                os,
            ),
        },
    };
}

/** The root stack's screens, as root-stack.tsx builds them. */
export function rootScreens(variant: VariantName = 'development', source?: RootStateSource) {
    const stand = Object.fromEntries(
        ROOT_ROUTE_NAMES.map((name) => [name, name === 'Tabs' ? tabsTree(variant) : blank]),
    ) as never;
    return source === undefined ? staticScreens(stand, variant) : staticScreens(stand, variant, source);
}
