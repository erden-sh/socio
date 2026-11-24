import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// React Navigation's linking functions and its stack and tab routers, loaded under
// Node. The app imports them from @react-navigation/native, which re-exports
// @react-navigation/core's (and core the routers') and also loads React
// Native, which Node can't. So this loads the core that native itself
// resolves: the same code, without React Native.

type Native = typeof import('@react-navigation/native');

export type NavigationCore = Pick<
    Native,
    | 'createPathConfigForStaticNavigation'
    | 'getStateFromPath'
    | 'getActionFromState'
    | 'getFocusedRouteNameFromRoute'
    | 'StackRouter'
    | 'TabRouter'
>;

const nativeDir = realpathSync(join(import.meta.dirname, '../../node_modules/@react-navigation/native'));
const corePath = createRequire(join(nativeDir, 'package.json')).resolve('@react-navigation/core');

export const navigationCore = (await import(pathToFileURL(corePath).href)) as NavigationCore;
