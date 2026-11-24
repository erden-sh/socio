import { inspectAttachment } from '@socio/foundation/issues/attachments';
import type { IssueAttachmentType } from '@socio/shared/issues/issue-types';

import { IssueError } from './contract.js';

/**
 * Validates an upload: size, a type detected from the content (the client's
 * declared type must agree when given), and an extension that matches it.
 * Throws 413 for size and 415 for anything else. The checks themselves are
 * `inspectAttachment` (`@socio/foundation/issues/attachments`).
 */
export function checkAttachment(
    name: string,
    declared: string | undefined,
    data: Uint8Array,
): { name: string; mediaType: IssueAttachmentType } {
    const checked = inspectAttachment(name, declared, data);
    if (checked.refused) {
        throw new IssueError(checked.message, checked.status);
    }
    return { name: checked.name, mediaType: checked.mediaType };
}
