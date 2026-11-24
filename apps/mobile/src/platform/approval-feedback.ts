import * as Haptics from 'expo-haptics';

import type { ApprovalFeedback } from '../sync/approval-actions';

import { deviceSettings } from './device-settings';

// An approval decision's haptic: success or error,
// only while the phone's haptics setting is on.

export const approvalFeedback: ApprovalFeedback = (kind) => {
    if (!deviceSettings.get().haptics) {
        return;
    }
    const type = kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error;
    Haptics.notificationAsync(type).catch(() => {});
};
