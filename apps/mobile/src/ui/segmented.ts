// The segmented control's rules, under Node: what a choice holds and
// each platform's size. UISegmentedControl is 32 pt tall (iOS's own; the
// control keeps a 44 pt hit area itself), Material 3's segmented button 40 dp.

export interface SegmentedOption<Value extends string> {
    readonly value: Value;
    readonly label: string;
    /** What a screen reader says when the label alone isn't enough (an icon's meaning). */
    readonly accessibilityLabel?: string;
    /** Android's segment testID (Maestro); iOS's segments have none, so flows tap their labels. */
    readonly testID?: string;
}

/** The most choices a segmented control takes; more go in a menu (HIG: "five or fewer", fewer on a phone). */
export const SEGMENTED_MAX = 4;

export function segmentedLayout(os: string): { readonly minHeight: number } {
    return { minHeight: os === 'ios' ? 32 : 40 };
}
