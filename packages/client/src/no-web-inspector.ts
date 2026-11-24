// Stand-in for @copilotkit/web-inspector. vite.config.ts and
// vitest.shared.ts alias the package here, so the inspector, its
// notification feed (cdn.copilotkit.ai) and its telemetry
// (telemetry.copilotkit.ai) are never bundled. CopilotKit only loads the
// package with a dynamic import when the inspector is on, and
// copilotkit-options.ts turns it off. If something still loads it, the
// import fails and CopilotKit logs "Failed to load CopilotKit inspector".
throw new Error('The CopilotKit web inspector is not part of Socio.');
