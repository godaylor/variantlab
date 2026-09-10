import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const container = 'variantlab-m8-postgres';
const database = 'variantlab';
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr?.toString()}`);
  return result.stdout?.toString().trim() ?? '';
}
function sql(db, query) {
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'variantlab_admin', '-d', db], { input: query });
}
const inspection = JSON.parse(docker(['inspect', container]))[0];
if (inspection.Config.Labels['com.docker.compose.project'] !== 'variantlab-m8'
  || !inspection.Mounts.some(m => m.Name === 'variantlab-m8-postgres-data' && m.Destination === '/var/lib/postgresql/data')) {
  throw new Error('Refusing a container/volume outside VariantLab');
}
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const dir = path.join(root, '.variantlab-backups', stamp);
mkdirSync(dir, { recursive: true });
const dumpPath = path.join(dir, 'variantlab-pre-m8.dump');
const dumpFd = openSync(dumpPath, 'wx');
try {
  docker(['exec', container, 'pg_dump', '-U', 'variantlab_admin', '-d', database, '-Fc'], { stdio: ['ignore', dumpFd, 'pipe'] });
} finally { closeSync(dumpFd); }
const restoreDb = `variantlab_m8_restore_${stamp}`;
const fixtureDb = `variantlab_m8_fixture_${stamp}`;
const freshDb = `variantlab_m8_fresh_${stamp}`;
const tables = sql(database, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").split('\n');
function fingerprint(db) {
  return tables.map(table => {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected table identifier');
    return sql(db, `BEGIN READ ONLY; SELECT '${table}', count(*), md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text),'')) FROM public.${table} t; COMMIT;`);
  });
}
const before = fingerprint(database);
sql('postgres', `CREATE DATABASE ${restoreDb};`);
const dumpInput = openSync(dumpPath, 'r');
try {
  docker(['exec', '-i', container, 'pg_restore', '-U', 'variantlab_admin', '-d', restoreDb, '--exit-on-error', '--single-transaction'], { stdio: [dumpInput, 'pipe', 'pipe'] });
} finally { closeSync(dumpInput); }
const restored = fingerprint(restoreDb);
if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error('Restore row counts/checksums differ');
console.log('Backup + full-row restore verification: PASS');
const migrationsDir = path.join(root, 'rust/services/connected/migrations');
const migrationNames = readdirSync(migrationsDir).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
if (migrationNames.slice(0, 3).join(',') !== '0001_m8_connected.sql,0002_worker_watchdog.sql,0003_campaign_revision_snapshot_contract.sql') throw new Error('Unexpected original migration chain');
const migrations = migrationNames.map(name => readFileSync(path.join(migrationsDir, name), 'utf8'));
sql('postgres', `CREATE DATABASE ${fixtureDb};`);
sql(fixtureDb, `BEGIN; ${migrations[0]} ${migrations[1]} COMMIT;`);
sql(fixtureDb, `INSERT INTO tenants (id,name) VALUES ('fixture-a','fixture'),('fixture-b','fixture');
INSERT INTO campaigns (tenant_id,id,name) VALUES ('fixture-a','legacy','fixture'),('fixture-a','new','fixture');
INSERT INTO campaign_revisions (tenant_id,campaign_id,revision,snapshot_hash,render_manifest)
VALUES ('fixture-a','legacy',1,repeat('a',64),'{"schema_version":1,"unknown_future_field":{"keep":true}}');`);
sql(fixtureDb, `BEGIN; ${migrations.slice(2).join('\n')} COMMIT;`);
const statement = readFileSync(path.join(root, 'rust/services/connected/src/revision_snapshot.sql'), 'utf8');
const tests = readFileSync(path.join(root, 'rust/services/connected/tests/snapshot_contract.sql'), 'utf8');
console.log(sql(fixtureDb, `PREPARE persist_revision(text,text,integer,text,jsonb) AS ${statement}; ${tests}`));
const partStatement = readFileSync(path.join(root, 'rust/services/connected/src/upload_part_receipt.sql'), 'utf8');
const partTests = readFileSync(path.join(root, 'rust/services/connected/tests/upload_receipt_contract.sql'), 'utf8');
console.log(sql(fixtureDb, `PREPARE persist_part(text,uuid,jsonb) AS ${partStatement}; ${partTests}`));
for (const name of ['auth_contract.sql', 'recovery_contract.sql', 'sync_review_contract.sql']) {
  const testPath = path.join(root, 'rust/services/connected/tests', name);
  if (existsSync(testPath)) console.log(sql(fixtureDb, readFileSync(testPath, 'utf8')));
}
sql('postgres', `CREATE DATABASE ${freshDb};`);
sql(freshDb, `BEGIN; ${migrations.join('\n')} COMMIT;`);
console.log(`Fresh schema ${migrationNames.map(name => name.slice(0,4)).join(' -> ')}: PASS`);
if (JSON.stringify(before) !== JSON.stringify(fingerprint(database))) throw new Error('Source changed during preflight; take a new backup');
const receipt = {
  at: new Date().toISOString(), container, volume: 'variantlab-m8-postgres-data', database,
  dumpPath, dumpSha256: createHash('sha256').update(readFileSync(dumpPath)).digest('hex'),
  restoreDb, fixtureDb, freshDb, before, restored,
  migrations: migrationNames.map((name, i) => ({ name, sha384: createHash('sha384').update(migrations[i]).digest('hex') })),
  sourceUnchanged: true, backupRestore: 'PASS', migrationFixtures: 'PASS',
};
writeFileSync(path.join(dir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Receipt: ${path.relative(root, path.join(dir, 'receipt.json'))}`);
console.log('Live database was not migrated. Verification databases are retained for inspection.');
