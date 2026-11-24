import { File } from 'expo-file-system';

import type { FileSystem } from '../data/layout';
import type { AttachmentFiles } from '../sync/attachments';

import { sha256BytesHex } from './crypto';
import { fileUri } from './file-system';

// The file operations attachments need (src/sync/attachments.ts) on
// expo-file-system 58: the store's list, remove and mkdir, a copy from the
// picker's file into `attachments/`, and the copy as the upload's body
// (expo-file-system's File is a Blob, which expo/fetch sends as it is). An
// issue file is read as base64 for its JSON body (File.base64(), no
// line breaks on either platform) and hashed with expo-crypto for the check.

/** The slice of expo-file-system's File the binding uses, so a test can hand in a fake. */
export interface ExpoFileClass {
    new (uri: string): Blob & {
        copy(destination: unknown): Promise<void>;
        base64(): Promise<string>;
        bytes(): Promise<Uint8Array<ArrayBuffer>>;
    };
}

export function createAttachmentFiles(
    fs: FileSystem,
    FileClass: ExpoFileClass = File,
    hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string> = sha256BytesHex,
): AttachmentFiles {
    return {
        list: fs.list,
        remove: fs.remove,
        mkdir: fs.mkdir,
        copy: async (from, to) => {
            await new FileClass(fileUri(from)).copy(new FileClass(fileUri(to)));
        },
        body: async (path) => new FileClass(fileUri(path)),
        base64: (path) => new FileClass(fileUri(path)).base64(),
        sha256: async (path) => hash(await new FileClass(fileUri(path)).bytes()),
    };
}
