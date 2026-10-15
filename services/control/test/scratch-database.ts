/**
 * Drops a test's scratch database after its pool has ended. `pool.end()` resolves before the ended
 * connections have left the server, and DROP … WITH (FORCE) would terminate them; the terminated
 * client, already removed from the pool, then has no error listener and the failure surfaces as an
 * uncaught exception that fails the whole file. Wait for the database's sessions to leave first;
 * FORCE stays as the fallback for a session that never does.
 */
export async function dropScratchDatabase(
  admin: {query: (text: string, values?: unknown[]) => Promise<{rows: any[]}>},
  name: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const {rows} = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
    if (rows[0]?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
