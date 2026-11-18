import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('memocean:migrations:v1'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of (await readdir(directory)).filter((file) => /^\d+_[a-z_]+\.sql$/.test(file)).sort()) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ sha256: string }>('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]);
      if (previous.rowCount) {
        if (previous.rows[0]?.sha256 !== hash) throw new Error(`Applied migration checksum changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
        await client.query('COMMIT'); applied.push(name);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('memocean:migrations:v1'))").catch(() => undefined);
    client.release(); await pool.end();
  }
  return applied;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required; never migrate with runtime credentials');
  const applied = await migrate(url);
  console.info(JSON.stringify({ migrations_applied: applied }));
}
