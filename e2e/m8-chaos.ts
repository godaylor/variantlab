import { expect, type BrowserContext, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";

const docker = (args: string[]) =>
	execFileSync("docker", args, { encoding: "utf8" }).trim();
const sql = (query: string) =>
	docker([
		"exec",
		"variantlab-m8-postgres",
		"psql",
		"-U",
		"variantlab_admin",
		"-d",
		"variantlab",
		"-At",
		"-v",
		"ON_ERROR_STOP=1",
		"-c",
		query,
	]);
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

function copyFixtureObject(from: string, to: string) {
	const [config] = JSON.parse(docker(["inspect", "variantlab-m8-minio"]));
	const env = new Map<string, string>(
		config.Config.Env.map((entry: string) => {
			const index = entry.indexOf("=");
			return [entry.slice(0, index), entry.slice(index + 1)];
		}),
	);
	const host = `http://${encodeURIComponent(env.get("MINIO_ROOT_USER")!)}:${encodeURIComponent(env.get("MINIO_ROOT_PASSWORD")!)}@minio:9000`;
	try {
		execFileSync(
			"docker",
			[
				"run",
				"--rm",
				"--network",
				"variantlab-m8-network",
				"--env",
				`MC_HOST_local=${host}`,
				"quay.io/minio/mc:RELEASE.2025-07-21T05-28-08Z",
				"cp",
				`local/variantlab-m8/${from}`,
				`local/variantlab-m8/${to}`,
			],
			{ stdio: "pipe" },
		);
	} catch {
		throw new Error("Test object copy failed; provider output suppressed");
	}
}

/** Faults affect only this test tenant's object mapping and the disposable stream. */
export async function verifyChaosBatch(
	context: BrowserContext,
	batchId: string,
	testInfo: TestInfo,
) {
	expect(batchId).toMatch(/^[a-f0-9-]{36}$/);
	const rows = JSON.parse(
		sql(
			`SELECT json_agg(json_build_object('id',id,'tenant',tenant_id)) FROM jobs WHERE batch_id='${batchId}'`,
		),
	) as Array<{ id: string; tenant: string }>;
	expect(rows).toHaveLength(50);
	expect(
		sql(
			`SELECT count(*) FROM jobs WHERE batch_id<>'${batchId}' AND state IN ('queued','preparing','running','cancelling')`,
		),
	).toBe("0");
	const source = JSON.parse(
		sql(
			`SELECT json_build_object('hash',a.asset_hash,'key',a.object_key,'png',(SELECT object_key FROM media_assets WHERE tenant_id=a.tenant_id AND content_type='image/png' LIMIT 1)) FROM media_assets a JOIN jobs j ON j.tenant_id=a.tenant_id AND j.source_object_key=a.object_key WHERE j.batch_id='${batchId}' LIMIT 1`,
		),
	) as { hash: string; key: string; png: string };
	const mapping = (key: string) =>
		sql(
			`UPDATE media_assets SET object_key=${quoted(key)} WHERE tenant_id=${quoted(rows[0].tenant)} AND asset_hash=${quoted(source.hash)}`,
		);
	const page = await context.newPage();
	await page.goto("/variantlab");
	const post = (path: string) =>
		page.evaluate(async (path) => {
			const r = await fetch(`/api/variantlab${path}`, { method: "POST" });
			return { status: r.status, body: await r.json() };
		}, path);
	const terminalCount = () =>
		sql(
			`SELECT count(*) FROM jobs WHERE batch_id='${batchId}' AND state IN ('succeeded','failed','cancelled')`,
		);
	const codes = () =>
		JSON.parse(
			sql(
				`SELECT coalesce(json_agg(DISTINCT failure->>'code'),'[]') FROM jobs WHERE batch_id='${batchId}' AND state='failed'`,
			),
		) as string[];
	try {
		expect((await post(`/jobs/${rows.at(-1)!.id}/cancel`)).status).toBe(200);
		await expect
			.poll(() =>
				sql(
					`SELECT count(*) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}') AND published_at IS NOT NULL`,
				),
			)
			.toBe("50");
		mapping(`${source.key}.chaos-missing`);
		// A real Redis outage must leave both processes alive and retrying.
		docker(["stop", "variantlab-m8-redis"]);
		docker(["start", "variantlab-m8-worker"]);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		for (const name of ["variantlab-m8-worker", "variantlab-m8-dispatcher"]) expect(JSON.parse(docker(["inspect", name]))[0].State.Running).toBe(true);
		docker(["start", "variantlab-m8-redis"]);
		docker([
			"exec",
			"variantlab-m8-redis",
			"redis-cli",
			"DEL",
			"variantlab:m8:render-jobs",
		]);
			docker(["start", "variantlab-m8-redis"]);
			docker(["start", "variantlab-m8-worker"]);
		await expect
			.poll(codes, { timeout: 45_000, intervals: [200] })
			.toContain("source_download_failed");
		mapping(source.key);
		await expect
			.poll(terminalCount, { timeout: 480_000, intervals: [1000] })
			.toBe("50");
		const before = JSON.parse(
			sql(
				`SELECT json_agg(json_build_object('id',id,'state',state,'attempt',attempt)) FROM jobs WHERE batch_id='${batchId}'`,
			),
		) as Array<{ id: string; state: string; attempt: number }>;
		const failed = before.filter((job) => job.state === "failed");
		expect(failed.length).toBeGreaterThan(0);
		copyFixtureObject(source.png, `${source.key}.chaos-checksum`);
		mapping(`${source.key}.chaos-checksum`);
		const board = page.getByRole("region", { name: "VariantLab cloud batch" });
		await board
			.getByRole("button", { name: "Retry failed only", exact: true })
			.click();
		await expect
			.poll(
				() =>
					sql(
						`SELECT count(*) FROM jobs WHERE batch_id='${batchId}' AND state='failed' AND attempt=2`,
					),
				{ timeout: 60_000, intervals: [250] },
			)
			.toBe(String(failed.length));
		expect(codes()).toEqual(["source_checksum_mismatch"]);
		mapping(source.key);
		await board
			.getByRole("button", { name: "Retry failed only", exact: true })
			.click();
		await expect
			.poll(
				() =>
					sql(
						`SELECT count(*) FROM jobs WHERE batch_id='${batchId}' AND state='succeeded'`,
					),
				{ timeout: 120_000, intervals: [1000] },
			)
			.toBe("49");
		const final = sql(
			`SELECT json_agg(json_build_object('id',id,'state',state,'attempt',attempt) ORDER BY id) FROM jobs WHERE batch_id='${batchId}'`,
		);
		const values = JSON.parse(final) as typeof before;
		for (const job of values)
			expect(job.attempt).toBe(failed.some((old) => old.id === job.id) ? 3 : 1);
		expect(values.filter((job) => job.state === "cancelled")).toHaveLength(1);
		// Duplicate deliveries and terminal mutations must not create attempts/artifacts.
		for (const job of [
			values.find((job) => job.state === "succeeded")!,
			values.find((job) => job.state === "cancelled")!,
		]) {
			docker([
				"exec",
				"variantlab-m8-redis",
				"redis-cli",
				"XADD",
				"variantlab:m8:render-jobs",
				"*",
				"tenant_id",
				rows[0].tenant,
				"job_id",
				job.id,
			]);
			expect((await post(`/jobs/${job.id}/retry`)).status).toBe(400);
			expect((await post(`/jobs/${job.id}/cancel`)).status).toBe(400);
		}
		expect((await post(`/batches/${batchId}/retry-failed`)).body.retried).toBe(
			0,
		);
		await expect
			.poll(() =>
				sql(
					`SELECT json_agg(json_build_object('id',id,'state',state,'attempt',attempt) ORDER BY id) FROM jobs WHERE batch_id='${batchId}'`,
				),
			)
			.toBe(final);
		expect(
			sql(
				`SELECT count(*) FROM export_artifacts WHERE job_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}')`,
			),
		).toBe("49");
		await testInfo.attach("m8-chaos.json", {
			body: JSON.stringify({
				cells: 50,
				cancelled: 1,
				artifacts: 49,
				redisStreamDeleted: true,
				postgresRebuiltDispatch: true,
				objectNotFound: true,
				checksumMismatch: true,
				retryFailedOnly: true,
				duplicateTerminalDelivery: true,
				succeededAttemptsPreserved: true,
				failedItems: failed.length,
			}),
			contentType: "application/json",
		});
	} finally {
		mapping(source.key);
		docker(["start", "variantlab-m8-worker"]);
	}
}
