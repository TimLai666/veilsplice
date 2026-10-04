// Prepare an ignored, generic binding descriptor for the MIT Sites build plugin.
// No Site ID, owner identity, credential or live database identifier is included.
import { mkdir, writeFile } from 'node:fs/promises';
const folder = new URL('../.openai/', import.meta.url);
await mkdir(folder, { recursive: true });
try {
  await writeFile(new URL('hosting.json', folder), JSON.stringify({ d1: 'DB' }, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error; // Never overwrite deployment-local metadata.
}
