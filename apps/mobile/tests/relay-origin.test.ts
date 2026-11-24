import { describe, expect, it } from 'vitest';

import { embeddedRelayOrigin, relayOrigin } from '../relay-origin';

// The push relay's origin: SOCIO_RELAY_ORIGIN at prebuild, an origin
// over https, or plain http to a local host in development only.

describe('SOCIO_RELAY_ORIGIN', () => {
    it('is none when unset or empty', () => {
        expect(relayOrigin(undefined, 'production')).toBeNull();
        expect(relayOrigin('', 'preview')).toBeNull();
    });

    it('takes an https origin in every variant', () => {
        for (const variant of ['development', 'preview', 'production'] as const) {
            expect(relayOrigin('https://relay.example.test', variant)).toBe('https://relay.example.test');
            expect(relayOrigin('https://relay.example.test:8443', variant)).toBe('https://relay.example.test:8443');
        }
    });

    it('takes plain http only to a local host, and only in development', () => {
        expect(relayOrigin('http://localhost:8787', 'development')).toBe('http://localhost:8787');
        expect(relayOrigin('http://10.0.2.2:8787', 'development')).toBe('http://10.0.2.2:8787');
        expect(() => relayOrigin('http://localhost:8787', 'preview')).toThrow(/not https/);
        expect(() => relayOrigin('http://relay.example.test', 'development')).toThrow(/not https/);
    });

    it('refuses anything but an origin', () => {
        for (const value of [
            'relay.example.test',
            'https://relay.example.test/',
            'https://relay.example.test/v1',
            'https://relay.example.test?x=1',
            'https://user@relay.example.test',
            'ftp://relay.example.test',
        ]) {
            expect(() => relayOrigin(value, 'development'), value).toThrow(/SOCIO_RELAY_ORIGIN/);
        }
    });

    it('reads the embedded value leniently: anything it wouldn’t take is none', () => {
        expect(embeddedRelayOrigin('https://relay.example.test', 'production')).toBe('https://relay.example.test');
        expect(embeddedRelayOrigin(undefined, 'production')).toBeNull();
        expect(embeddedRelayOrigin({}, 'production')).toBeNull();
        expect(embeddedRelayOrigin('http://localhost:8787', 'production')).toBeNull();
    });
});
