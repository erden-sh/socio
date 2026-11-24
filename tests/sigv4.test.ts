import { expect, it } from 'vitest';

import { canonicalQuery, sha256Hex, signRequest, uriEncode } from '../src/server/storage/sigv4.js';

const example = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
};

it('matches AWS’s published S3 GET Object example', () => {
    const headers = signRequest({
        ...example,
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        headers: { Range: 'bytes=0-9' },
        bodyHash: sha256Hex(''),
    });
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers.authorization).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
});

it('matches AWS’s ListObjects example (a query string)', () => {
    // The same page of the S3 docs: GET /?max-keys=2&prefix=J.
    const headers = signRequest({
        ...example,
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
        bodyHash: sha256Hex(''),
    });
    expect(headers.authorization).toMatch(
        /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
    );
});

it('encodes the query per RFC 3986 and sorts it, without double encoding the path', () => {
    expect(uriEncode("a b/c~d*e!'()")).toBe('a%20b%2Fc~d%2Ae%21%27%28%29');
    expect(
        canonicalQuery(
            new URLSearchParams({
                prefix: 'tenants/main/',
                'list-type': '2',
                'continuation-token': 'a+b=',
            }),
        ),
    ).toBe('continuation-token=a%2Bb%3D&list-type=2&prefix=tenants%2Fmain%2F');
    const sign = (url: string) =>
        signRequest({ ...example, method: 'GET', url, bodyHash: sha256Hex('') }).authorization;
    // An already-encoded segment signs like its decoded form, once.
    expect(sign('http://s3.test:8333/bucket/a%20b')).toBe(sign('http://s3.test:8333/bucket/a b'));
    // The port is part of the signed host.
    expect(sign('http://s3.test:8333/bucket/k')).not.toBe(sign('http://s3.test:9000/bucket/k'));
});
