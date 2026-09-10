// Run with repository-pinned Bun: node script/bun.mjs script/sbom.mjs
// Inventory locked versions, not a claim that every optional package is shipped.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
const root = path.resolve(import.meta.dir, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const sha = (file) => createHash("sha256").update(readFileSync(path.join(root,file))).digest("hex");
const bun = ts.parseConfigFileTextToJson("bun.lock", read("bun.lock"));
if (bun.error) throw new Error("Invalid bun.lock");
const cargo = Bun.TOML.parse(read("Cargo.lock"));
const components = new Map();
const missing = [];
const metadataFile = "docs/SBOM-npm-license-evidence.json";
const npmEvidence = existsSync(path.join(root,metadataFile)) ? JSON.parse(read(metadataFile)) : {};
const bunStorePath = path.join(root,"node_modules/.bun");
const storeDirs = existsSync(bunStorePath) ? readdirSync(bunStorePath) : [];
const license = (value) => typeof value === "string" && value.length ? [{license:{name:value}}] : undefined;
for (const entry of Object.values(bun.config.packages)) {
  const identity = entry[0];
  const split = identity.lastIndexOf("@");
  if (split <= 0) continue;
  const name = identity.slice(0,split), version = identity.slice(split+1);
  if (!/^\d+\.\d+\.\d+/.test(version)) continue;
  const ref = `pkg:npm/${name.replace("@","%40")}@${version}`;
  if (components.has(ref)) continue;
  const prefix = `${name.replaceAll("/","+")}@${version}`;
  const directory = storeDirs.find(item => item === prefix || item.startsWith(prefix+"_"));
  const manifestCandidates = [
    directory ? `node_modules/.bun/${directory}/node_modules/${name}/package.json` : undefined,
    `node_modules/${name}/package.json`,
  ].filter(Boolean);
  const file = manifestCandidates.find((candidate) => {
    if (!existsSync(path.join(root, candidate))) return false;
    const value = JSON.parse(read(candidate));
    return value.name === name && value.version === version;
  });
  let meta;
  if (file) meta = JSON.parse(read(file));
  const licenseFile = file ? path.posix.join(path.posix.dirname(file),"LICENSE") : undefined;
  if (!meta?.license && licenseFile && existsSync(path.join(root,licenseFile)) && read(licenseFile).startsWith("MIT License")) meta = {license:"MIT",source:licenseFile};
  if (!meta?.license && npmEvidence[identity]) meta = npmEvidence[identity];
  if (!meta?.license && process.argv.includes("--fetch-missing")) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    const response = await fetch(url,{signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error(`Metadata unavailable: ${identity}: ${response.status}`);
    const value = await response.json();
    if (value.name !== name || value.version !== version) throw new Error(`Metadata identity mismatch: ${identity}`);
    npmEvidence[identity] = {license:value.license ?? null,source:url};
    writeFileSync(path.join(root,metadataFile),JSON.stringify(npmEvidence,null,2)+"\n");
    meta = npmEvidence[identity];
  }
  if (!meta?.license) missing.push(ref);
  const integrity = entry.find(value => typeof value === "string" && /^sha(256|512)-/.test(value));
  const hashes = integrity ? [{alg:integrity.startsWith("sha512")?"SHA-512":"SHA-256", content:Buffer.from(integrity.split("-")[1],"base64").toString("hex")}] : undefined;
  components.set(ref,{type:"library",name,version,"bom-ref":ref,purl:ref,hashes,licenses:license(meta?.license),properties:[{name:"variantlab:scope",value:"bun.lock; includes optional/dev dependencies"},{name:"variantlab:license-evidence",value:`locked package manifest/license or pinned npm evidence: ${identity}`}]});
}
const registryRoot = ".cargo-tools/registry/src";
const registries = existsSync(path.join(root,registryRoot)) ? readdirSync(path.join(root,registryRoot)) : [];
for (const pkg of cargo.package) {
  const ref = `pkg:cargo/${pkg.name}@${pkg.version}`;
  let metadata;
  let evidence = "workspace source";
  for (const registry of registries) {
    const file = `${registryRoot}/${registry}/${pkg.name}-${pkg.version}/Cargo.toml`;
    if (existsSync(path.join(root,file))) {
      // Bun 1.2.18 cannot parse some numeric-leading feature keys; read only
      // the standard package table needed for license evidence.
      const packageTable = read(file).match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
      metadata = packageTable ? Bun.TOML.parse(packageTable[0]).package : undefined;
      evidence=file; break;
    }
  }
  if (pkg.source && !metadata?.license) missing.push(ref);
  components.set(ref,{type:"library",name:pkg.name,version:pkg.version,"bom-ref":ref,purl:ref,hashes:pkg.checksum?[{alg:"SHA-256",content:pkg.checksum}]:undefined,licenses:license(metadata?.license ?? (!pkg.source ? "MIT" : undefined)),properties:[{name:"variantlab:scope",value:pkg.source ?? "workspace"},{name:"variantlab:license-evidence",value:evidence}]});
}
for (const file of ["bun.lock","Cargo.lock","assets/fonts/inter-4.1/Inter-Regular.ttf"]) {
  if (!existsSync(path.join(root,file))) continue;
  components.set(file,{type:"file",name:file,"bom-ref":file,hashes:[{alg:"SHA-256",content:sha(file)}]});
}
const document = {bomFormat:"CycloneDX",specVersion:"1.6",version:1,metadata:{component:{type:"application",name:"VariantLab",version:"M8-working-tree"},properties:[{name:"variantlab:inventory-scope",value:"Complete Bun and Cargo lock inventory. Not an OS/image SBOM or legal clearance. Missing license metadata is explicitly listed in the receipt."}]},components:[...components.values()].sort((a,b)=>a["bom-ref"].localeCompare(b["bom-ref"]))};
writeFileSync(path.join(root,"docs/SBOM.cdx.json"),JSON.stringify(document,null,2)+"\n");
const receipt={bunLockSha256:sha("bun.lock"),cargoLockSha256:sha("Cargo.lock"),components:document.components.length,missingLicenseMetadata:missing.sort()};
writeFileSync(path.join(root,"docs/SBOM-coverage.json"),JSON.stringify(receipt,null,2)+"\n");
writeFileSync(path.join(root,metadataFile),JSON.stringify(npmEvidence,null,2)+"\n");
console.log(JSON.stringify({components:receipt.components,missingLicenseMetadata:missing.length}));

