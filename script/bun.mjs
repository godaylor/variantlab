import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.versions.node !== '22.15.1') throw new Error('VariantLab requires Node.js 22.15.1; select a repo-local runtime, do not change the global installation.');
const local = path.join(root, '.variantlab-tools', process.platform === 'win32' ? 'bun.exe' : 'bun');
const binary = process.env.VARIANTLAB_BUN_BINARY ?? (existsSync(local) ? local : 'bun');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== '1.2.18') throw new Error('Provide existing Bun 1.2.18 through VARIANTLAB_BUN_BINARY or .variantlab-tools/bun.exe. This script never installs a runtime.');
const env = { ...process.env, VARIANTLAB_BUN_BINARY: binary };
if (path.isAbsolute(binary)) env.PATH = `${path.dirname(binary)}${path.delimiter}${process.env.PATH}`;
const run = spawnSync(binary, process.argv.slice(2), { cwd: root, env, stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
