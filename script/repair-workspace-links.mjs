// Bun's Windows junctions contain absolute paths. Repair only links pointing
// into the former checkout after this repository has been moved.
import { readdir, readlink, realpath, lstat, unlink, symlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const root = await realpath(new URL('../', import.meta.url));
const oldRoot = process.argv[2];
if (!oldRoot || !isAbsolute(oldRoot)) throw new Error('Pass the absolute former checkout path.');
const previous = resolve(oldRoot);
if (previous.toLowerCase() === root.toLowerCase()) throw new Error('Old and current checkout must differ.');
let repaired = 0;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const suffix = relative(previous, target);
      if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) continue;
      const destination = resolve(root, suffix);
      const stat = await lstat(destination).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      await unlink(path);
      await symlink(destination, path, stat.isDirectory() ? 'junction' : 'file');
      repaired++;
    } else if (entry.isDirectory()) await visit(path);
  }
}
for (const base of ['node_modules', 'apps', 'packages', 'rust/wasm']) {
  const directory = resolve(root, base);
  if (base === 'node_modules') await visit(directory);
  else {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modules = resolve(directory, entry.name, 'node_modules');
      if (await lstat(modules).catch(() => null)) await visit(modules);
    }
  }
}
console.log(`Repaired ${repaired} moved-checkout dependency links.`);
