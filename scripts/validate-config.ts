import { loadConfig } from '../src/config/load';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'config/routes.json');
try {
  const config = loadConfig(file);
  console.log(`${file}: OK (${config.routes.length} route(s), ${config.routes.filter((r) => r.enabled).length} enabled)`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
