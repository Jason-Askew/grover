const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { initDb, query, closePool } = require('../persistence/db');

const DEFAULT_DUMP = path.join(__dirname, '../../config/grover-seed.dump');

/**
 * Restore the grover database from a pg_dump seed file.
 * Skips restore if the database already has chunk data.
 */
async function bootstrap(dumpFile = null) {
  const file = dumpFile || DEFAULT_DUMP;

  if (!fs.existsSync(file)) {
    console.log(`Seed dump not found: ${file}`);
    console.log('Run "node grover.js ingest" to build the index from corpus files instead.');
    process.exit(1);
  }

  // Parse DATABASE_URL for pg_restore connection params
  const dbUrl = process.env.DATABASE_URL || 'postgres://grover:grover@localhost:5432/grover';
  const url = new URL(dbUrl);
  const host = url.hostname;
  const port = url.port || '5432';
  const user = url.username || 'grover';
  const dbName = url.pathname.slice(1) || 'grover';
  const password = url.password || process.env.POSTGRES_PASSWORD || 'grover';

  // Ensure schema exists before restore
  await initDb();

  // Check if data already exists
  try {
    // Use count(id) — ruvector extension has a bug where count(*) returns 0
    const res = await query('SELECT count(id) FROM chunks');
    const count = parseInt(res.rows[0].count, 10);
    if (count > 0) {
      console.log(`Database already has ${count} chunks. Skipping restore.`);
      console.log('To force a fresh restore, drop existing data first:');
      console.log('  TRUNCATE chunks, documents, graphs, memories, feedback, usage_stats CASCADE;');
      await closePool();
      return;
    }
  } catch (e) {
    // Table doesn't exist yet — that's fine, restore will create it
  }

  await closePool();

  console.log(`Restoring from ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)...`);

  try {
    execSync(
      `pg_restore --no-owner --no-privileges --dbname="${dbUrl}" "${file}"`,
      { stdio: 'inherit', env: { ...process.env, PGPASSWORD: password }, timeout: 120000 }
    );
  } catch (e) {
    // pg_restore exits non-zero on warnings (e.g. "relation already exists") — check if data landed
  }

  // Verify
  await initDb();
  const chunkRes = await query('SELECT index_name, count(*) FROM chunks GROUP BY index_name');
  const docRes = await query('SELECT index_name, count(*) FROM documents GROUP BY index_name');
  const graphRes = await query('SELECT index_name, node_count, edge_count FROM graphs ORDER BY index_name');

  if (chunkRes.rows.length === 0) {
    console.log('\nRestore failed — no data found. Check PostgreSQL connection and dump file.');
    await closePool();
    process.exit(1);
  }

  console.log('\nDatabase restored:');
  for (const row of chunkRes.rows) {
    const docs = docRes.rows.find(d => d.index_name === row.index_name);
    const graph = graphRes.rows.find(g => g.index_name === row.index_name);
    console.log(`  ${row.index_name}: ${docs?.count || '?'} documents, ${row.count} chunks` +
      (graph ? `, ${graph.node_count} graph nodes` : ''));
  }

  await closePool();
}

module.exports = { bootstrap };
