import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateJsonSchema } from '../src/config/jsonSchema';

const out = path.resolve(__dirname, '../config/routes.schema.json');
writeFileSync(out, `${JSON.stringify(generateJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${out}`);
