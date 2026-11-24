import type { FileSystem, WorkspaceLayout } from './layout';

// The data protection of a workspace's two folders of plain files.
// Neither is SQLCipher:
//
// - `images/`, the app's own image cache, is `complete` on iOS: unreadable
//   whenever the phone is locked, as nothing needs an image then.
// - `attachments/`, the copies of picked attachments, keeps the keys' unlock
//   level (`completeUntilFirstUserAuthentication`, as secure-store's
//   AFTER_FIRST_UNLOCK), so the outbox can still upload them while the phone
//   is locked.
//
// On iOS a directory's class is also the class new files in it get, so each
// folder is made and given its class before anything goes in it, and again
// whenever it may have been deleted (Clear cache deletes `images/`). Android's
// file-based encryption covers both, and socio-device's call changes nothing
// there. No React Native: the platform hands in socio-device's
// `setFileProtection`, and tests/data runs this under Node.

/** iOS data protection classes, by socio-device's names. */
export type FileProtectionLevel = 'complete' | 'completeUnlessOpen' | 'completeUntilFirstUserAuthentication' | 'none';

/** Sets a file's or directory's protection class (socio-device's `setFileProtection`). */
export type SetFileProtection = (path: string, level: FileProtectionLevel) => Promise<void>;

/** The image cache's class: locked with the phone. */
export const IMAGES_PROTECTION: FileProtectionLevel = 'complete';
/** Picked attachments' class: the keys' unlock level, readable while locked after the first unlock. */
export const ATTACHMENTS_PROTECTION: FileProtectionLevel = 'completeUntilFirstUserAuthentication';

export interface WorkspaceFilesDeps {
    readonly fs: Pick<FileSystem, 'mkdir'>;
    readonly setFileProtection: SetFileProtection;
}

/** Makes `images/` if needed and gives it its class. Call it before writing an image. */
export async function prepareImagesFolder(deps: WorkspaceFilesDeps, layout: WorkspaceLayout): Promise<void> {
    await deps.fs.mkdir(layout.images);
    await deps.setFileProtection(layout.images, IMAGES_PROTECTION);
}

/** Makes `attachments/` if needed and gives it its class. Call it before copying an attachment. */
export async function prepareAttachmentsFolder(deps: WorkspaceFilesDeps, layout: WorkspaceLayout): Promise<void> {
    await deps.fs.mkdir(layout.attachments);
    await deps.setFileProtection(layout.attachments, ATTACHMENTS_PROTECTION);
}

/** Both folders, each with its class: as a workspace's scope opens. */
export async function prepareWorkspaceFolders(deps: WorkspaceFilesDeps, layout: WorkspaceLayout): Promise<void> {
    await prepareImagesFolder(deps, layout);
    await prepareAttachmentsFolder(deps, layout);
}
