import { execFileSync } from "node:child_process";

// Refresh a stateless local verification container while retaining a rollback
// container. Inspect only in memory: credentials must never enter receipts.
const name = process.argv[2];
if (!["variantlab-m8-web-release-check", "variantlab-m8-worker", "variantlab-m8-api", "variantlab-m8-dispatcher"].includes(name)) {
	throw new Error("Only named VariantLab stateless local containers may be refreshed");
}
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const [old] = JSON.parse(docker(["inspect", name]));
if (old.Mounts.length) throw new Error("Refusing a container with persistent mounts");
const networks = Object.keys(old.NetworkSettings.Networks);
if (networks.length !== 1 || networks[0] !== "variantlab-m8-network") throw new Error("Unexpected network");
const ports = Object.entries(old.HostConfig.PortBindings ?? {}).flatMap(([target, bindings]) => bindings.map(binding => {
	const port = Number(binding.HostPort);
	if (binding.HostIp !== "127.0.0.1" || port < 32200 || port > 32299) throw new Error("Port is outside local task allocation");
	return ["-p", `${binding.HostIp}:${port}:${target}`];
})).flat();
const backup = `${name}-rollback-${Date.now()}`;
const runtimeEnv = [...old.Config.Env];
if (name === "variantlab-m8-web-release-check" && !runtimeEnv.some(value => value.startsWith("VARIANTLAB_SITE_URL="))) {
	const publicSiteUrl = runtimeEnv.find(value => value.startsWith("NEXT_PUBLIC_SITE_URL="))?.slice("NEXT_PUBLIC_SITE_URL=".length);
	if (publicSiteUrl) runtimeEnv.push(`VARIANTLAB_SITE_URL=${publicSiteUrl}`);
}
// Refresh from this service's newly built tag, even if its previous container
// was started by an image ID whose tag has since moved.
docker(["image", "inspect", name]);
docker(["stop", name]);
docker(["rename", name, backup]);
try {
	docker(["run", "-d", "--name", name, "--network", networks[0],
		...Object.entries(old.Config.Labels ?? {}).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
		"--label", "variantlab.owner=variantlab-m8",
		...(name === "variantlab-m8-worker" ? ["--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "128", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=1073741824", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"] : []),
		...Object.values(old.NetworkSettings.Networks).flatMap(n => (n.Aliases ?? []).filter(alias => alias !== old.Id && alias !== name && alias !== old.Id.slice(0, 12)).flatMap(alias => ["--network-alias", alias])),
		...ports, ...runtimeEnv.flatMap(value => ["--env", value]), name]);
	console.log(`Refreshed ${name}; rollback retained as ${backup}`);
} catch {
	try { docker(["rm", "-f", name]); } catch { /* no new container */ }
	docker(["rename", backup, name]); docker(["start", name]);
	throw new Error("Local refresh failed; previous container restored (details suppressed to protect environment)");
}
