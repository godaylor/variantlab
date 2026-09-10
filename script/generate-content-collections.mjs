import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuilder } from "@content-collections/core";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configurationPath = path.join(
	repositoryRoot,
	"apps",
	"web",
	"content-collections.ts",
);

const builder = await createBuilder(configurationPath);
await builder.build();
