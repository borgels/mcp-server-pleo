import { PleoClient } from '../src/pleo/client.js';

async function main(): Promise<void> {
  if (!process.env.PLEO_API_KEY && !process.env.PLEO_ACCESS_TOKEN) {
    console.error('Skipping live smoke test: set PLEO_API_KEY or PLEO_ACCESS_TOKEN.');
    return;
  }

  const client = new PleoClient();
  const introspection = await client.get('/v1/introspect');
  console.log(JSON.stringify({ ok: true, introspection }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
