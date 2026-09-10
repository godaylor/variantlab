import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const receiptPath = path.resolve(root, process.argv[2] ?? '');
if (!receiptPath.startsWith(path.join(root, '.variantlab-backups') + path.sep)) throw new Error('Provide a repo-private preflight receipt');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.backupRestore !== 'PASS' || receipt.migrationFixtures !== 'PASS') throw new Error('Preflight gates did not pass');
if (createHash('sha256').update(readFileSync(receipt.dumpPath)).digest('hex') !== receipt.dumpSha256) throw new Error('Backup checksum mismatch');
for (const migration of receipt.migrations) {
  const content = readFileSync(path.join(root, 'rust/services/connected/migrations', migration.name));
  if (createHash('sha384').update(content).digest('hex') !== migration.sha384) throw new Error('Migration changed after fixtures');
}
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
  if (r.status !== 0) throw new Error(`Docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const pg = JSON.parse(docker(['inspect', 'variantlab-m8-postgres']))[0];
if (pg.Config.Labels['com.docker.compose.project'] !== 'variantlab-m8'
  || !pg.Mounts.some(m => m.Name === receipt.volume)) throw new Error('Wrong project volume');
const password = pg.Config.Env.find(e => e.startsWith('POSTGRES_PASSWORD=')).slice('POSTGRES_PASSWORD='.length);
const apiEnv = JSON.parse(docker(['inspect', 'variantlab-m8-api']))[0].Config.Env
  .filter(e => /^(DATABASE_URL|REDIS_URL|S3_|VARIANTLAB_BFF_SECRET)/.test(e));
const psql = (db, query) => docker(['exec', '-i', 'variantlab-m8-postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'variantlab_admin', '-d', db], { input: query });
for (const row of receipt.before) {
  const table = row.split('|')[0];
  if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected table');
  const actual = psql('variantlab', `BEGIN READ ONLY; SELECT '${table}', count(*), md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text),'')) FROM public.${table} t; COMMIT;`);
  if (actual !== row) throw new Error('Source changed after backup; repeat preflight');
}
function migrate(db) {
  docker(['run', '--rm', '--network', 'variantlab-m8-network',
    ...apiEnv.flatMap(e => ['--env', e]), '--env', 'VARIANTLAB_MODE=migrate',
    '--env', `DATABASE_ADMIN_URL=postgresql://variantlab_admin:${encodeURIComponent(password)}@postgres:5432/${db}`,
    'variantlab-m8-api']);
}
migrate(receipt.restoreDb);
migrate(receipt.restoreDb);
const expectedLedger = receipt.migrations.map(m => `${Number(m.name.slice(0,4))}|t`).join('\n');
if (psql(receipt.restoreDb, 'SELECT version,success FROM _sqlx_migrations ORDER BY version;') !== expectedLedger) throw new Error('Restored database did not receive the expected embedded migration chain; live database untouched');
console.log('SQLx upgrade + second no-op run against restored database: PASS');
migrate('variantlab');
const installed = psql('variantlab', 'SELECT version,success FROM _sqlx_migrations ORDER BY version;');
if (installed !== expectedLedger) throw new Error('Unexpected migration ledger after application');
for (const row of receipt.before.filter(r => !r.startsWith('_sqlx_migrations|') && !r.startsWith('campaign_revisions|'))) {
  const table = row.split('|')[0];
  const actual = psql('variantlab', `SELECT '${table}', count(*), md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text),'')) FROM public.${table} t;`);
  if (actual !== row) throw new Error('Unrelated data changed during migration');
}
writeFileSync(path.join(path.dirname(receiptPath), 'application.json'), JSON.stringify({ at: new Date().toISOString(), installed, volume: receipt.volume, unaffectedRows: 'PASS', sqlxRestoreUpgradeAndIdempotence: 'PASS' }, null, 2));
console.log(`Local VariantLab SQLx migration chain through ${receipt.migrations.at(-1).name.slice(0,4)}: PASS; existing media/upload rows unchanged`);
