// The app's User-Agent: `Socio/<version> (<device>; <OS> <major>)`, such as
// `Socio/0.1.0 (iPhone; iOS 26)` or `Socio/0.1.0 (Android; Android 16)`. It says
// which app and platform asked, and nothing about the person or the phone: no
// name, email, account, device name or model, nor the OS's minor version.
// The values come from the
// platform (src/platform/user-agent.ts), never from React Native here, and
// anything that isn't a plain version number is dropped, so nothing else can
// slip into the header.

export interface ClientInfo {
    /** The app's version (`0.1.0`). */
    appVersion: string;
    platform: 'ios' | 'android';
    /** The OS's version (`26.1`, `16`); only its major number is sent. */
    osVersion: string | number;
    /** An iPad rather than an iPhone (iOS only). */
    tablet?: boolean;
}

const APP_VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
const MAJOR = /^\d{1,3}/;

export function userAgent({ appVersion, platform, osVersion, tablet = false }: ClientInfo): string {
    const version = APP_VERSION.test(appVersion) ? appVersion : '0.0.0';
    const major = MAJOR.exec(String(osVersion))?.[0];
    const os = platform === 'ios' ? 'iOS' : 'Android';
    const device = platform === 'ios' ? (tablet ? 'iPad' : 'iPhone') : 'Android';
    return `Socio/${version} (${device}; ${major === undefined ? os : `${os} ${major}`})`;
}
