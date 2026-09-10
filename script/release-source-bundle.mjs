// Exact source and notice preparation; this does not make a legal clearance claim.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".release/third-party"); mkdirSync(out, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const records = [];
for (const pin of JSON.parse(readFileSync(path.join(root, "docs/RELEASE_SOURCE_PINS.json")))) {
  const target = path.join(out, pin.name);
  if (!existsSync(target)) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Source unavailable: ${pin.name}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024 || digest(bytes) !== pin.sha256) throw new Error(`Source integrity: ${pin.name}`);
    writeFileSync(target, bytes);
  }
  if (digest(readFileSync(target)) !== pin.sha256) throw new Error(`Source integrity: ${pin.name}`);
  records.push({ file: pin.name, sha256: pin.sha256, upstream: pin.url });
}
const bunStore = path.join(root, "node_modules/.bun");
let noticeCount = 0;
const moduleRoots = [path.join(root, "node_modules")];
if (existsSync(bunStore)) for (const entry of readdirSync(bunStore)) moduleRoots.push(path.join(bunStore, entry, "node_modules"));
const visited = new Set();
for (let index = 0; index < moduleRoots.length; index++) {
  const modules = moduleRoots[index];
  if (!existsSync(modules)) continue;
  const packageDirs = readdirSync(modules, { withFileTypes: true }).filter(v => !v.name.startsWith(".") && (v.isDirectory() || v.isSymbolicLink())).flatMap(v => v.name.startsWith("@") ? readdirSync(path.join(modules,v.name)).map(n => path.join(modules,v.name,n)) : [path.join(modules,v.name)]);
  for (const directory of packageDirs) {
    if (!existsSync(path.join(directory,"package.json"))) continue;
    const resolved = realpathSync(directory);
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    moduleRoots.push(path.join(directory, "node_modules"));
    // Workspace links are application source, not third-party packages.
    if (!resolved.split(path.sep).includes("node_modules")) continue;
    const meta = JSON.parse(readFileSync(path.join(directory,"package.json")));
    const label = `${meta.name.replaceAll("/", "+")}@${meta.version}`;
    for (const file of readdirSync(directory).filter(n => /^(licen[sc]e|copying|notice|copyright)([.-]|$)/i.test(n))) {
      const from = path.join(directory,file); const to = path.join(out,"notices/npm",label,file);
      mkdirSync(path.dirname(to),{recursive:true}); cpSync(from,to,{recursive:true}); noticeCount++;
    }
    if (meta.name === "mediabunny" && meta.version === "1.41.0") cpSync(directory,path.join(out,"mediabunny-1.41.0"),{recursive:true});
  }
}
const registry = path.join(root,".cargo-tools/registry/src");
if (!existsSync(registry)) throw new Error("Build Rust first to materialize the pinned crate sources");
for (const source of readdirSync(registry)) for (const crate of readdirSync(path.join(registry,source))) {
  const directory = path.join(registry,source,crate);
  for (const file of readdirSync(directory).filter(n => /^(licen[sc]e|copying|notice|copyright)([.-]|$)/i.test(n))) {
    const to = path.join(out,"notices/cargo",crate,file); mkdirSync(path.dirname(to),{recursive:true}); cpSync(path.join(directory,file),to,{recursive:true}); noticeCount++;
  }
}
for (const file of ["LICENSE","THIRD_PARTY_NOTICES.md","docs/SBOM.cdx.json","docs/SBOM-coverage.json","rust/services/connected/Dockerfile","assets/fonts/inter-4.1/LICENSE.txt","assets/fonts/inter-4.1/PROVENANCE.md"]) {
  const target=path.join(out,file); mkdirSync(path.dirname(target),{recursive:true}); cpSync(path.join(root,file),target);
}
if (!existsSync(path.join(out,"mediabunny-1.41.0/src/index.ts")) || noticeCount === 0) throw new Error("Source/notice bundle incomplete");
const coverage = JSON.parse(readFileSync(path.join(root,"docs/SBOM-coverage.json")));
if (coverage.missingLicenseMetadata.length) throw new Error("Unresolved license metadata");
const receipt = { sourceArchives: records, copiedNoticeFiles: noticeCount, mediabunny: "1.41.0 source and LICENSE copied verbatim", soundtouchjs: "0.3.0 complete source and build scripts at npm gitHead", ffmpeg: "7.1.1 complete upstream source, exact provider build instructions included", scope: "Local distribution preparation. Infrastructure images and platform-optional/dev packages are inventoried separately. Legal approval and hosting the source bundle alongside the release remain publication decisions." };
writeFileSync(path.join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
writeFileSync(path.join(root,"docs/RELEASE_SOURCE_RECEIPT.json"),JSON.stringify(receipt,null,2)+"\n");
console.log(`Source bundle prepared: ${noticeCount} notice files; ${records.length} verified source archives; Mediabunny source.`);
