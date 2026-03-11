import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NormalizedSnapshot } from './types.js';

export async function writeJsonAtomic(filePath: string, payload: NormalizedSnapshot): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}
