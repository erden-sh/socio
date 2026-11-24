// Socio replaces @segment/analytics-node with this package (pnpm
// overrides in the root package.json). CopilotKit's telemetry client
// (@copilotkit/shared, telemetry-client) does `new Analytics({ writeKey })`
// and calls `track(...)`. This class has the real one's public methods; each
// does nothing. It opens no sockets and calls no fetch. Event methods still
// call their callback, so code that waits on one does not hang.
'use strict';

const done = (callback) => {
    if (typeof callback === 'function') queueMicrotask(() => callback());
};

class Analytics {
    constructor(settings) {
        void settings;
        this.ready = Promise.resolve();
    }
    get VERSION() {
        return '0.0.0-noop';
    }
    alias(params, callback) {
        done(callback);
    }
    group(params, callback) {
        done(callback);
    }
    identify(params, callback) {
        done(callback);
    }
    page(params, callback) {
        done(callback);
    }
    screen(params, callback) {
        done(callback);
    }
    track(params, callback) {
        done(callback);
    }
    flush() {
        return Promise.resolve();
    }
    closeAndFlush() {
        return Promise.resolve();
    }
    register() {
        return Promise.resolve();
    }
    deregister() {
        return Promise.resolve();
    }
    on() {
        return this;
    }
    once() {
        return this;
    }
    off() {
        return this;
    }
    emit() {
        return false;
    }
}

module.exports = { Analytics, default: Analytics, isNoop: true };
