import { expect, type BrowserContext, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";

const sql = (query: string) =>
	execFileSync(
		"docker",
		[
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
		],
		{ encoding: "utf8" },
	).trim();

export async function verifyFiftyCellBatch(
	context: BrowserContext,
	batchId: string,
	testInfo: TestInfo,
) {
	expect(batchId).toMatch(/^[a-f0-9-]{36}$/);
	// Capture first publication before the 10-second lost-stream watchdog can
	// republish queued jobs and legitimately replace published_at.
	await expect
		.poll(
			() =>
				sql(
					`SELECT count(*) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}') AND published_at IS NOT NULL`,
				),
			{ timeout: 5000 },
		)
		.toBe("50");
	const firstDispatch = JSON.parse(
		sql(
			`SELECT json_build_object('p95',percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (published_at-created_at))*1000),'ageMs',max(extract(epoch FROM (now()-created_at))*1000)) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}')`,
		),
	);
	expect(firstDispatch.ageMs).toBeLessThan(10_000);
	const page = await context.newPage();
	await page.addInitScript(() => {
		const state = { longTasks: [] as number[] };
		Object.assign(window, { cloudPerformance: state });
		new PerformanceObserver((list) =>
			state.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
		).observe({ type: "longtask", buffered: false });
	});
	await page.goto("/variantlab");
	const board = page.getByRole("region", { name: "VariantLab cloud batch" });
	await expect(board).toBeVisible();
	await page.evaluate(() => {
		(
			window as unknown as { cloudPerformance: { longTasks: number[] } }
		).cloudPerformance.longTasks = [];
	});
	await expect
		.poll(
			() =>
				sql(
					`SELECT count(*) FROM jobs WHERE batch_id='${batchId}' AND state='succeeded'`,
				),
			{ timeout: 480_000, intervals: [1000] },
		)
		.toBe("50");
	await expect(
		board.getByRole("button", { name: "Download", exact: true }),
	).toHaveCount(50);
	const metrics = JSON.parse(
		sql(`SELECT json_build_object(
	 'jobs',count(*),'artifacts',(SELECT count(*) FROM export_artifacts WHERE job_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}')),
	 'dispatchP95Ms',(SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (published_at-created_at))*1000) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM jobs WHERE batch_id='${batchId}')),
	 'renderTimeFactorP95',(SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (a.finished_at-a.started_at))/((j.render_manifest->>'sequence_duration_ticks')::numeric/48000)) FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.batch_id='${batchId}'),
	 'maximumConcurrentAttempts',(SELECT max((SELECT count(*) FROM job_attempts b JOIN jobs k ON k.id=b.job_id WHERE k.batch_id='${batchId}' AND b.started_at <= a.started_at AND b.finished_at > a.started_at)) FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.batch_id='${batchId}')
	) FROM jobs WHERE batch_id='${batchId}'`),
	);
	const longTasks = await page.evaluate(
		() =>
			(window as unknown as { cloudPerformance: { longTasks: number[] } })
				.cloudPerformance.longTasks,
	);
	const evidence = {
		corpus:
			"m8-moving-webm-v1: 50 explicitly enabled cells, moving 640x360 VP8/Opus source, authored Cyrillic text and PNG, mixed 1080p delivery profiles",
		browser: context.browser()?.version(),
		host: {
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			memoryBytes: totalmem(),
		},
		...metrics,
		dispatchP95Ms: firstDispatch.p95,
		dispatchCapturedAtAgeMs: firstDispatch.ageMs,
		longTasks,
	};
	await testInfo.attach("m8-50-cell-performance.json", {
		body: JSON.stringify(evidence, null, 2),
		contentType: "application/json",
	});
	expect(metrics.jobs).toBe(50);
	expect(metrics.artifacts).toBe(50);
	expect(firstDispatch.p95).toBeLessThan(2000);
	expect(metrics.maximumConcurrentAttempts).toBe(1);
	expect(metrics.renderTimeFactorP95).toBeGreaterThan(0);
	expect(longTasks).toEqual([]);
}
