import { AndroidConfig, type ConfigPlugin, withAndroidManifest } from 'expo/config-plugins';

import { withResXml } from './res-xml.ts';

// Android's backup rules: neither cloud backup nor a
// device-to-device transfer takes the device store or the secrets that open it.
//
// - `files/socio/` holds every workspace's directory (cache.db, user.db, their -wal and -shm,
//   attachments, images) and the app's registry. Restored without the keys that open them, the
//   files would only be deleted again, so they never leave the phone.
// - `shared_prefs/SecureStore.xml` is expo-secure-store's: values wrapped by Android Keystore keys,
//   which never leave the device either. Its config plugin would write rules of its own, so it runs
//   with `configureAndroidBackup: false` (app.config.ts) and these rules cover it.
//
// Everything else backs up as Android does by default. `dataExtractionRules` serves Android 12
// and later, `fullBackupContent` Android 11 and earlier.

export const BACKUP_RULES = 'backup_rules';
export const DATA_EXTRACTION_RULES = 'data_extraction_rules';

/** What no backup or transfer takes: the `domain` and `path` of each `<exclude>`. */
export const BACKUP_EXCLUDES = [
    { domain: 'file', path: 'socio/' },
    { domain: 'sharedpref', path: 'SecureStore.xml' },
] as const;

const excludes = (indent: string) =>
    BACKUP_EXCLUDES.map(({ domain, path }) => `${indent}<exclude domain="${domain}" path="${path}" />`);

/** `res/xml/backup_rules.xml`, Auto Backup's rules on Android 11 and earlier. */
export function fullBackupContentXml(): string {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<full-backup-content>',
        ...excludes('  '),
        '</full-backup-content>',
        '',
    ].join('\n');
}

/** `res/xml/data_extraction_rules.xml`, for cloud backup and device transfer on Android 12 and later. */
export function dataExtractionRulesXml(): string {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<data-extraction-rules>',
        '  <cloud-backup>',
        ...excludes('    '),
        '  </cloud-backup>',
        '  <device-transfer>',
        ...excludes('    '),
        '  </device-transfer>',
        '</data-extraction-rules>',
        '',
    ].join('\n');
}

const withBackupRules: ConfigPlugin = (config) => {
    const withManifest = withAndroidManifest(config, (next) => {
        const application = AndroidConfig.Manifest.getMainApplicationOrThrow(next.modResults);
        application.$['android:fullBackupContent'] = `@xml/${BACKUP_RULES}`;
        application.$['android:dataExtractionRules'] = `@xml/${DATA_EXTRACTION_RULES}`;
        return next;
    });
    return withResXml(
        withResXml(withManifest, BACKUP_RULES, fullBackupContentXml()),
        DATA_EXTRACTION_RULES,
        dataExtractionRulesXml(),
    );
};

export default withBackupRules;
