import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const image = "variantlab-rust:1.91.1-wasm-pack-0.13.1-v3";

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureImage() {
	const inspect = spawnSync("docker", ["image", "inspect", image], {
		cwd: repositoryRoot,
		stdio: "ignore",
	});
	if (inspect.status !== 0) {
		run("docker", [
			"build",
			"--file",
			"rust/Dockerfile.toolchain",
			"--tag",
			image,
			".",
		]);
	}
}

function inContainer(args, environment = []) {
	run("docker", [
		"run",
		"--rm",
		...environment.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
		"--volume",
		`${repositoryRoot}:/workspace`,
		"--volume",
		`${path.join(repositoryRoot, ".cargo-tools/registry")}:/usr/local/cargo/registry`,
		"--volume",
		`${path.join(repositoryRoot, ".cargo-tools/git")}:/usr/local/cargo/git`,
		"--volume",
		`${path.join(repositoryRoot, ".cargo-tools/wasm-pack-cache")}:/root/.cache/.wasm-pack`,
		"--workdir",
		"/workspace",
		image,
		...args,
	]);
}

ensureImage();
const action = process.argv[2];
if (action === "fetch") {
	inContainer(["cargo", "fetch", "--locked"]);
	// Cargo runs as root in this pinned container. Some upstream crate archives
	// carry owner-only modes; host-side notice packaging must be able to read
	// these public dependency sources without running the packager as root.
	inContainer(["chmod", "-R", "a+rX", "/usr/local/cargo/registry/src"]);
} else if (action === "test") {
	inContainer(["cargo", "test", "--locked", "--workspace", "--all-features"], [["CARGO_BUILD_JOBS", "1"]]);
} else if (action === "connected-test") {
	inContainer(["cargo", "test", "--locked", "-p", "variantlab-connected"], [["CARGO_BUILD_JOBS", "1"]]);
} else if (action === "clippy") {
	inContainer([
		"cargo",
		"clippy",
		"--locked",
		"--workspace",
		"--all-targets",
		"--all-features",
		"--",
		"-D",
		"warnings",
	], [["CARGO_BUILD_JOBS", "1"]]);
} else if (action === "fmt") {
	inContainer(["cargo", "fmt", "--all", "--", "--check"]);
} else if (action === "contracts") {
	inContainer(
		[
			"cargo",
			"test",
			"-p",
			"studio-model",
			"-p",
			"timeline-engine",
			"-p",
			"creative-engine",
			"-p",
			"media-plan",
			"-p",
			"variant-engine",
			"-p",
			"render-plan",
			"-p",
			"codec-policy",
			"-p",
			"job-contracts",
			"--lib",
		],
		[["TS_RS_EXPORT_DIR", "/workspace/packages/studio-contract/src/generated"]],
	);
} else if (action === "wasm") {
	inContainer([
		"wasm-pack",
		"build",
		"rust/wasm",
		"--target",
		"bundler",
		"--out-dir",
		"pkg",
		"--release",
	]);
	rmSync(path.join(repositoryRoot, "rust/wasm/pkg/.gitignore"), {
		force: true,
	});
} else {
	console.error("Usage: node script/rust-toolchain.mjs test|clippy|fmt|contracts|wasm");
	process.exit(2);
}
