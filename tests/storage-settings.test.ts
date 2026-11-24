import { expect, it } from 'vitest';

import { s3SettingsFromEnv, storageSettingsFromEnv } from '@socio/data/storage/settings';

const identityFile = JSON.stringify({
    identities: [
        {
            name: 'someone-else',
            credentials: [{ accessKey: 'OTHER', secretKey: 'other-secret' }],
        },
        {
            name: 'company-brain',
            credentials: [{ accessKey: 'AK-FROM-SEAWEED', secretKey: 'sk-from-seaweed' }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
    ],
});

it('stays on the local disk until S3 is configured', () => {
    expect(storageSettingsFromEnv({})).toEqual({
        driver: 'local',
        tenantId: 'main',
    });
    expect(
        storageSettingsFromEnv({
            STORAGE_DRIVER: 'local',
            S3_ENDPOINT: 'http://s3:8333',
            TENANT_ID: 'acme-1',
        }),
    ).toEqual({ driver: 'local', tenantId: 'acme-1' });
});

it('reads S3 from the endpoint, with SeaweedFS’s identity file as the credentials', () => {
    expect(
        storageSettingsFromEnv({
            S3_ENDPOINT: 'http://company-brain-s3:8333/',
            S3_CREDENTIALS: identityFile,
        }),
    ).toEqual({
        driver: 's3',
        tenantId: 'main',
        s3: {
            endpoint: 'http://company-brain-s3:8333',
            bucket: 'company-brain',
            region: 'us-east-1',
            forcePathStyle: true,
            accessKeyId: 'AK-FROM-SEAWEED',
            secretAccessKey: 'sk-from-seaweed',
        },
    });
    expect(
        storageSettingsFromEnv({
            STORAGE_DRIVER: 'S3',
            S3_ENDPOINT: 'https://s3.example.test',
            S3_BUCKET: 'brain-files',
            S3_REGION: 'eu-west-1',
            S3_IDENTITY: 'someone-else',
            S3_CREDENTIALS: identityFile,
        }).s3,
    ).toMatchObject({
        bucket: 'brain-files',
        region: 'eu-west-1',
        accessKeyId: 'OTHER',
    });
    expect(
        storageSettingsFromEnv({
            S3_ENDPOINT: 'http://s3:8333',
            S3_CREDENTIALS: '{"accessKeyId":" AK ","secretAccessKey":"SK"}',
        }).s3,
    ).toMatchObject({ accessKeyId: 'AK', secretAccessKey: 'SK' });
});

it('refuses incomplete or malformed settings without echoing secrets', () => {
    const failure = (env: Record<string, string>) => {
        try {
            storageSettingsFromEnv(env);
        } catch (error) {
            return (error as Error).message;
        }
        return 'no error';
    };
    expect(failure({ STORAGE_DRIVER: 's3' })).toBe(
        'STORAGE_DRIVER=s3 needs S3_ENDPOINT and S3_CREDENTIALS (or S3_CREDENTIALS_FILE).',
    );
    expect(failure({ S3_ENDPOINT: 'http://s3:8333' })).toMatch(/needs S3_ENDPOINT and S3_CREDENTIALS/);
    expect(failure({ STORAGE_DRIVER: 'gcs' })).toBe('STORAGE_DRIVER must be local or s3.');
    expect(failure({ TENANT_ID: 'Main Workspace' })).toMatch(/^TENANT_ID must/);
    const base = { S3_ENDPOINT: 'http://s3:8333', S3_CREDENTIALS: identityFile };
    expect(failure({ ...base, S3_ENDPOINT: 'ftp://s3' })).toMatch(/^S3_ENDPOINT must be an http\(s\) origin/);
    expect(failure({ ...base, S3_ENDPOINT: 'http://s3:8333/bucket' })).toMatch(/without a path/);
    expect(failure({ ...base, S3_BUCKET: 'Bad_Bucket' })).toMatch(/^S3_BUCKET must/);
    expect(failure({ ...base, S3_IDENTITY: 'nobody' })).toBe(
        'S3_CREDENTIALS has no identity named nobody (S3_IDENTITY).',
    );
    const leaked = failure({
        ...base,
        S3_CREDENTIALS: 'not-json-super-secret-value',
    });
    expect(leaked).toBe('S3_CREDENTIALS must be JSON.');
    expect(failure({ ...base, S3_CREDENTIALS: '{"accessKeyId":"only-the-id"}' })).not.toContain('only-the-id');
    expect(failure({ ...base, S3_FORCE_PATH_STYLE: 'maybe' })).toBe('S3_FORCE_PATH_STYLE must be true or false.');
    expect(failure({ ...base, S3_FORCE_PATH_STYLE: 'false' })).toBe('no error');
    expect(
        failure({
            ...base,
            S3_ENDPOINT: 'http://10.0.0.5:9000',
            S3_FORCE_PATH_STYLE: 'false',
        }),
    ).toMatch(/needs a host name in S3_ENDPOINT/);
    expect(
        failure({
            ...base,
            S3_ENDPOINT: 'https://s3.example.test',
            S3_BUCKET: 'brain.files',
            S3_FORCE_PATH_STYLE: 'false',
        }),
    ).toMatch(/has dots, which break TLS/);
});

it('takes the generic key pair from any S3-compatible store, path-style or not', () => {
    expect(
        storageSettingsFromEnv({
            S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
            S3_BUCKET: 'acme-brain',
            S3_REGION: 'eu-west-1',
            S3_FORCE_PATH_STYLE: 'FALSE',
            S3_CREDENTIALS: '{"accessKeyId":"AKIA","secretAccessKey":"SK"}',
        }).s3,
    ).toEqual({
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        bucket: 'acme-brain',
        region: 'eu-west-1',
        forcePathStyle: false,
        accessKeyId: 'AKIA',
        secretAccessKey: 'SK',
    });
    // The off-site backup copy reads the same settings under BACKUP_S3_*.
    expect(
        s3SettingsFromEnv(
            {
                BACKUP_S3_ENDPOINT: 'https://offsite.example.test',
                BACKUP_S3_BUCKET: 'brain-backups',
                BACKUP_S3_CREDENTIALS: '{"accessKeyId":"B","secretAccessKey":"S"}',
            },
            'BACKUP_',
            { example: 'https://s3.example.com' },
        ),
    ).toMatchObject({ bucket: 'brain-backups', forcePathStyle: true });
    expect(() =>
        s3SettingsFromEnv(
            {
                BACKUP_S3_ENDPOINT: 'https://offsite.example.test',
                BACKUP_S3_CREDENTIALS: '{"accessKeyId":"B","secretAccessKey":"S"}',
            },
            'BACKUP_',
            { example: 'https://s3.example.com' },
        ),
    ).toThrow('BACKUP_S3_ENDPOINT needs BACKUP_S3_BUCKET.');
    expect(() =>
        s3SettingsFromEnv({ BACKUP_S3_ENDPOINT: 'https://offsite.example.test' }, 'BACKUP_', {
            example: 'https://s3.example.com',
        }),
    ).toThrow('BACKUP_S3_ENDPOINT needs BACKUP_S3_CREDENTIALS (or BACKUP_S3_CREDENTIALS_FILE).');
});
