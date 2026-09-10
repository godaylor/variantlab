import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root,".test-results/release-secret-scan",Date.now().toString());
const source = path.join(output,"source"); mkdirSync(source,{recursive:true});
const files = execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{cwd:root,encoding:"utf8"}).split("\0").filter(Boolean);
for(const file of new Set(files)) {
  const from=path.resolve(root,file); const to=path.resolve(source,file);
  if(!from.startsWith(root) || !to.startsWith(source+path.sep)) throw new Error("Unsafe repository path");
  if(!existsSync(from) || !statSync(from).isFile()) continue;
  mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);
}
execFileSync("docker",["run","--rm","-v",`${source}:/source:ro`,"-v",`${output}:/reports`,"zricethezav/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854","dir","/source","--redact=100","--report-format=json","--report-path=/reports/gitleaks.json","--exit-code=1"],{stdio:"inherit"});
console.log("Gitleaks working-tree scan passed; ignored private backups/runtime files were excluded from the release candidate.");
