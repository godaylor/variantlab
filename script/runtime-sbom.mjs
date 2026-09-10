// Scan immutable images, not live volumes or environment values.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const docker = args => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const scanner = "anchore/syft@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c";
const web = process.env.VARIANTLAB_RUNTIME_WEB ?? "variantlab-m8-web-release-check";
if (!["variantlab-m8-web-release-check", "variantlab-m8-web"].includes(web)) throw new Error("Unexpected web container");
const names = [web, "variantlab-m8-api", "variantlab-m8-worker", "variantlab-m8-dispatcher", "variantlab-m8-postgres", "variantlab-m8-redis", "variantlab-m8-minio"];
const out = fileURLToPath(new URL("../.release/runtime/", import.meta.url));
mkdirSync(out, { recursive: true });
const images = new Map(), components = new Map(), receipts = [];
for (const name of names) {
  const container = JSON.parse(docker(["inspect", name]))[0];
  const labels = container.Config.Labels ?? {};
  const localStateless = ["variantlab-m8-web-release-check", "variantlab-m8-api", "variantlab-m8-worker", "variantlab-m8-dispatcher"].includes(name) && container.Mounts.length === 0 && Object.keys(container.NetworkSettings.Networks).join() === "variantlab-m8-network";
  if (labels["com.docker.compose.project"] !== "variantlab-m8" && labels["variantlab.owner"] !== "variantlab-m8" && !localStateless) throw new Error("Unexpected owner: " + name);
  components.set(name, { type: "container", name, version: container.Image, "bom-ref": name, hashes: [{ alg: "SHA-256", content: container.Image.replace("sha256:", "") }] });
  let inventory = images.get(container.Image);
  if (!inventory) {
    console.log("Scanning immutable image for " + name);
    inventory = JSON.parse(docker(["run", "--rm", "--volume", "/var/run/docker.sock:/var/run/docker.sock:ro", scanner, "docker:" + container.Image, "--scope", "squashed", "-o", "cyclonedx-json"]));
    if (!inventory.components?.length) throw new Error("Empty image inventory: " + name);
    images.set(container.Image, inventory);
  }
  writeFileSync(out + name + ".cdx.json", JSON.stringify(inventory, null, 2) + "\n");
  for (const item of inventory.components) {
    const ref = item.purl ?? item.type + ":" + item.name + "@" + (item.version ?? "unknown");
    const existing = components.get(ref);
    if (existing) existing.properties.push({ name: "variantlab:observed-in", value: name });
    else components.set(ref, { ...item, "bom-ref": ref, properties: [...(item.properties ?? []), { name: "variantlab:observed-in", value: name }] });
  }
  receipts.push({ container: name, image: container.Image, components: inventory.components.length, withoutLicenseMetadata: inventory.components.filter(c => !c.licenses?.length).length });
}
const document = { bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "application", name: "VariantLab observed release runtime", version: "M8-M9" }, properties: [{ name: "variantlab:scanner", value: scanner }, { name: "variantlab:scope", value: "All seven immutable service images: OS packages and discoverable embedded dependencies. Combine with lock SBOM and corresponding source bundle. Detection is not legal clearance." }] }, components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])) };
writeFileSync(fileURLToPath(new URL("../docs/SBOM-runtime.cdx.json", import.meta.url)), JSON.stringify(document, null, 2) + "\n");
writeFileSync(fileURLToPath(new URL("../docs/SBOM-runtime-coverage.json", import.meta.url)), JSON.stringify({ scanner, images: receipts }, null, 2) + "\n");
console.log("Runtime inventory: " + document.components.length + " components across " + names.length + " services; no live environment or volume scanned.");
