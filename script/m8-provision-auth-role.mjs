// One-time local provisioning only after a restored-and-applied migration receipt.
// Does not rotate an existing password or recreate any database/container/volume.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const receiptPath = path.resolve(root, process.argv[2] ?? '');
if (!receiptPath.startsWith(path.join(root, '.variantlab-backups') + path.sep)) throw new Error('Expected private application receipt');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.unaffectedRows !== 'PASS' || receipt.sqlxRestoreUpgradeAndIdempotence !== 'PASS' || !receipt.installed.split('\n').includes('4|t')) throw new Error('Verified migration 0004 is required');
process.loadEnvFile(path.resolve(root, process.argv[3] ?? 'variantlab.env.example'));
const password = process.env.VARIANTLAB_AUTH_DB_PASSWORD;
if (!password || password.length < 24 || /[\r\n\0]/.test(password)) throw new Error('Auth DB password must have at least 24 characters');
function docker(args, input) {
  const r = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Auth role provisioning check failed (credentials are not logged)');
  return r.stdout.trim();
}
const pg = JSON.parse(docker(['inspect','variantlab-m8-postgres']))[0];
if (pg.Config.Labels['com.docker.compose.project'] !== 'variantlab-m8' || !pg.Mounts.some(m => m.Name === 'variantlab-m8-postgres-data')) throw new Error('Wrong project volume');
const sql = query => docker(['exec','-i','variantlab-m8-postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','variantlab_admin','-d','variantlab'], query);
const role = sql("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='variantlab_auth';");
if (role === 'f|f|f|f|f') {
  sql(`ALTER ROLE variantlab_auth LOGIN PASSWORD '${password.replaceAll("'", "''")}';`);
} else if (role !== 't|f|f|f|f') throw new Error('Unexpected existing auth role: no changes made');
// Already provisioned roles are checked, never silently rekeyed.
docker(['exec','variantlab-m8-postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1',`postgresql://variantlab_auth:${encodeURIComponent(password)}@127.0.0.1:5432/variantlab`,'-c','SELECT count(*) FROM users;']);
console.log('VariantLab auth role provisioned/verified; no existing password was rotated.');
