// CopilotKit's runtime creates its telemetry client (Segment, Scarf and the
// telemetry.copilotkit.ai ingest endpoint) when the module is first imported,
// and reads the opt-out from the environment at that moment. channels-core
// reads the same variables. This module must be the server entry's first
// import so the opt-out is in place before any @copilotkit package loads.
// It is unconditional: Socio sends no vendor telemetry. Better
// Auth's telemetry is off by default and also off in its options; without
// an endpoint variable it has nowhere to send.
process.env.DO_NOT_TRACK = '1';
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE = '0';
delete process.env.CPK_TELEMETRY_ID;
process.env.BETTER_AUTH_TELEMETRY = '0';
delete process.env.BETTER_AUTH_TELEMETRY_ENDPOINT;

export {};
