// Starts only this repository's web shell. Does not provision or mutate services.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../',import.meta.url));
assert.equal(process.versions.node,'22.15.1');
process.loadEnvFile(path.resolve(root,process.env.VARIANTLAB_ENV_FILE ?? 'variantlab.env.example'));
const production = process.argv[2] === 'production';
const port = Number(process.env.VARIANTLAB_WEB_VERIFY_PORT ?? (production ? 32270 : 32240));
if(!Number.isInteger(port) || port < (production ? 32270 : 32240) || port > (production ? 32289 : 32269)) throw new Error('Use the allocated VariantLab test/release port range');
if(!process.env.VARIANTLAB_AUTH_DB_PASSWORD || !process.env.VARIANTLAB_AUTH_SECRET) throw new Error('Local auth role configuration is required; no database changes were made');
const env = {...process.env,
    DATABASE_URL:`postgresql://variantlab_auth:${encodeURIComponent(process.env.VARIANTLAB_AUTH_DB_PASSWORD)}@127.0.0.1:${process.env.VARIANTLAB_POSTGRES_PORT ?? 32210}/variantlab`,
    BETTER_AUTH_SECRET:process.env.VARIANTLAB_AUTH_SECRET,
    NEXT_PUBLIC_SITE_URL:`http://127.0.0.1:${port}`,
    VARIANTLAB_SITE_URL:`http://127.0.0.1:${port}`,
    VARIANTLAB_CONTROL_PLANE_URL:`http://127.0.0.1:${process.env.VARIANTLAB_API_PORT ?? 32201}`,
    NEXT_PUBLIC_MARBLE_API_URL:'https://api.marblecms.com',
    UPSTASH_REDIS_REST_URL:'http://127.0.0.1:32220',UPSTASH_REDIS_REST_TOKEN:'variantlab-local',
    MARBLE_WORKSPACE_KEY:'variantlab-local',FREESOUND_CLIENT_ID:'variantlab-local',FREESOUND_API_KEY:'variantlab-local',
    HOSTNAME:'127.0.0.1',PORT:String(port),
};
function run(args) { const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'}); if(result.error) throw result.error; if(result.status !== 0) process.exit(result.status ?? 1); }
if(production) { run(['script/prepare-standalone.mjs']); run(['apps/web/.next/standalone/apps/web/server.js']); }
else run(['script/bun.mjs','run','--cwd','apps/web','dev','--','--hostname','127.0.0.1','--port',String(port)]);
