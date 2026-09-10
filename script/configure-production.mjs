import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

function origin(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname === 'localhost' || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('Use a public HTTPS hostname without credentials, port, path, query or fragment.');
  }
  return url.origin;
}
const site = origin(process.argv[2]);
const storage = origin(process.argv[3]);
if (site === storage) throw new Error('Storage requires a separate origin.');
const values = {
  VARIANTLAB_SITE_URL: site,
  VARIANTLAB_PUBLIC_STORAGE_URL: storage,
  VARIANTLAB_M8_TEST_MODE: '0',
  VARIANTLAB_PRODUCTION_WEB_PORT: '32280',
  VARIANTLAB_PRODUCTION_STORAGE_PORT: '32282',
  VARIANTLAB_MINIO_ROOT_USER: 'variantlab-storage',
};
for (const key of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'AUTH_DB_PASSWORD', 'DISPATCHER_DB_PASSWORD', 'MINIO_ROOT_PASSWORD', 'AUTH_SECRET', 'BFF_SECRET']) {
  values[`VARIANTLAB_${key}`] = randomBytes(32).toString('hex');
}
await writeFile(new URL('../.env.production', import.meta.url), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created private .env.production. Existing credentials are never overwritten.');
