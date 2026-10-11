export default async function teardown() {
  // Windows process termination skips JavaScript signal handlers. Ask the
  // loopback fixture to close clients, drop its database and stop its own PG.
  try {
    await fetch('http://127.0.0.1:3141/__catalog_fixture/shutdown', { method: 'POST',
      headers: { 'X-Catalog-Fixture': 'shutdown' }, signal: AbortSignal.timeout(3_000) });
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try { await fetch('http://127.0.0.1:3141/__catalog_fixture', { signal: AbortSignal.timeout(500) }); }
      catch { return; }
    }
  } catch { /* A failed setup already runs its own bounded cleanup. */ }
}
