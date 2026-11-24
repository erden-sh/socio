import type { Transporter } from 'nodemailer';

import type { SmtpSettings } from './settings.js';

/** Sends account email: password links and email verification. */
export interface Mailer {
    send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/**
 * Mail through the configured SMTP server, the only place account email
 * goes. The message carries the recipient's address and a link, nothing
 * else about them.
 */
export function smtpMailer(settings: SmtpSettings): Mailer {
    const url = new URL(settings.url);
    // Loaded on the first message: most deployments never send one.
    let transport: Promise<Transporter> | undefined;
    const connect = async () => {
        const { createTransport } = await import('nodemailer');
        return createTransport({
            host: url.hostname,
            port: Number(url.port) || (url.protocol === 'smtps:' ? 465 : 587),
            secure: url.protocol === 'smtps:',
            // Plain SMTP must upgrade with STARTTLS, except to a loopback relay.
            requireTLS: url.protocol === 'smtp:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
            ...(url.username
                ? {
                      auth: {
                          user: decodeURIComponent(url.username),
                          pass: settings.password ?? decodeURIComponent(url.password),
                      },
                  }
                : {}),
        });
    };
    return {
        async send({ to, subject, text }) {
            transport ??= connect();
            await (await transport).sendMail({ from: settings.from, to, subject, text });
        },
    };
}
