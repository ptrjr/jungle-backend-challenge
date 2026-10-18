import { Logger } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import { createApp } from '../../src/bootstrap';

async function main() {
  Logger.overrideLogger(false);
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  await writeFile(process.env.PROCESS_READY_FILE!, JSON.stringify({ pid: process.pid, url: await app.getUrl() }));
}
main().catch(error => { console.error(error); process.exit(1); });
