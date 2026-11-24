import { codingGitFromEnv } from './config.js';
import { createCodingGitServer } from './server.js';
import { CodingGit } from './service.js';

const config = codingGitFromEnv(process.env);
const server = createCodingGitServer(new CodingGit({ dir: config.dir }), config.secret);
server.listen(config.port, config.host, () => console.log(`coding-git listening on ${config.host}:${config.port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
