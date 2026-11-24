// Imported first by the bundle (index.ts), before any schema parses. zod 4
// tries `new Function('')` once to learn whether it may compile its parsers,
// which the page's CSP (no 'unsafe-eval') reports as a violation.
// Jitless parsers never try. The atoms' fences parse with shared's schemas
// (`dataset-view`, `embed-card`, `page-image`).
import { config } from 'zod';

config({ jitless: true });
