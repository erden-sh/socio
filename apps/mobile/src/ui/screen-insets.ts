import type { Edge } from 'react-native-safe-area-context';

// Which screens UIKit insets under a native bar (CB-420; screen.tsx). No React
// Native here, so the Node tests read it as the app does.

/** Whether UIKit insets a screen's content by the native bar over it: iOS, under a bar (no top edge). */
export const uikitInsets = (edges: readonly Edge[], os: string) => os === 'ios' && !edges.includes('top');
