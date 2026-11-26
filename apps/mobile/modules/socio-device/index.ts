// socio-device: Socio's own native module (README.md). Autolinking finds it in
// apps/mobile/modules, Expo's default folder for local modules.
export {
    addBackgroundGraceListener,
    addProtectedDataListener,
    appBuild,
    clearWebViewData,
    deleteAppSnapshots,
    excludeFromBackup,
    getFileProtection,
    holdBackgroundGrace,
    isExcludedFromBackup,
    isProtectedDataAvailable,
    openAuthTab,
    previewFile,
    processStartTime,
    reportFullyDrawn,
    saveFile,
    setFileProtection,
    toFilePath,
    wasPrewarmed,
} from './src/device';
export type { AppBuild, AuthTabResult, FilePreviewResult, FileProtection, FileSaveResult } from './src/native';
export { whenProtectedDataAvailable } from './src/protected-data';
