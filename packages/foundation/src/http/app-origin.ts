export function resolveAppOrigins(appOrigin: string | undefined, nodeEnv: string | undefined): string[] | undefined {
    if (appOrigin) {
        return appOrigin
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    }
    return nodeEnv === 'development' ? ['http://localhost:4310', 'http://127.0.0.1:4310'] : undefined;
}
