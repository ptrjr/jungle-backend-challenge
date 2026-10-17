import { createApp } from './bootstrap';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const app = await createApp();
  await app.listen(port, '0.0.0.0');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; });
