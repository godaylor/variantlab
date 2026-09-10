use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
};

use aws_sdk_s3::primitives::ByteStream;
use redis::streams::StreamReadReply;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tokio::{
    process::Command,
    time::{Duration, sleep},
};
use uuid::Uuid;

use crate::{api::tenant_tx, config::Config};

const STREAM: &str = "variantlab:m8:render-jobs";

struct ClaimedJob {
    tenant_id: String,
    job_id: String,
    manifest: render_plan::RenderManifest,
    idempotency_key: String,
    attempt: i32,
    worker_id: String,
}

pub async fn run(config: Config) -> Result<(), String> {
    let pool = config.pool().await.map_err(|error| error.to_string())?;
    let redis = redis::Client::open(config.redis_url.clone()).map_err(|error| error.to_string())?;
    let s3 = config.s3().await;
    let mut last_id = "0-0".to_owned();
    loop {
        let mut connection = redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|error| error.to_string())?;
        let reply: StreamReadReply = redis::cmd("XREAD")
            .arg("COUNT")
            .arg(10)
            .arg("BLOCK")
            .arg(1000)
            .arg("STREAMS")
            .arg(STREAM)
            .arg(&last_id)
            .query_async(&mut connection)
            .await
            .map_err(|error| error.to_string())?;
        for key in reply.keys {
            for entry in key.ids {
                last_id = entry.id.clone();
                let tenant_id = entry.get::<String>("tenant_id");
                let job_id = entry.get::<String>("job_id");
                if let (Some(tenant_id), Some(job_id)) = (tenant_id, job_id)
                    && let Some(job) =
                        claim_job(&pool, &config.worker_id, &tenant_id, &job_id).await?
                    && let Err(error) = execute_job(&pool, &s3, &config, &job).await
                {
                    fail_job(&pool, &job, &error).await?;
                }
            }
        }
        sleep(Duration::from_millis(20)).await;
    }
}

async fn claim_job(
    pool: &PgPool,
    worker_id: &str,
    tenant_id: &str,
    job_id: &str,
) -> Result<Option<ClaimedJob>, String> {
    let mut tx = tenant_tx(pool, tenant_id)
        .await
        .map_err(|error| error.message)?;
    let row = sqlx::query("UPDATE jobs SET state='preparing',phase='preparing',progress_milli=50,lease_owner=$3,lease_expires_at=now()+interval '45 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='queued' RETURNING render_manifest,idempotency_key,attempt")
        .bind(tenant_id).bind(job_id).bind(worker_id).fetch_optional(&mut *tx).await.map_err(|error| error.to_string())?;
    let Some(row) = row else {
        tx.rollback().await.map_err(|error| error.to_string())?;
        return Ok(None);
    };
    let attempt: i32 = row.get("attempt");
    sqlx::query("UPDATE job_attempts SET worker_id=$3,started_at=now() WHERE tenant_id=$1 AND job_id=$2 AND attempt=$4")
        .bind(tenant_id).bind(job_id).bind(worker_id).bind(attempt).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    let claimed = ClaimedJob {
        tenant_id: tenant_id.to_owned(),
        job_id: job_id.to_owned(),
        manifest: serde_json::from_value(row.get("render_manifest"))
            .map_err(|error| error.to_string())?,
        idempotency_key: row.get("idempotency_key"),
        attempt,
        worker_id: worker_id.to_owned(),
    };
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(Some(claimed))
}

async fn execute_job(
    pool: &PgPool,
    s3: &aws_sdk_s3::Client,
    config: &Config,
    job: &ClaimedJob,
) -> Result<(), String> {
    let scratch = PathBuf::from("/tmp/variantlab-m8");
    std::fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
    let token = Uuid::new_v4();
    let attempt_dir = scratch.join(token.to_string());
    std::fs::create_dir(&attempt_dir).map_err(|error| error.to_string())?;
    let output_path = attempt_dir.join("output.webm");
    let result = execute_job_files(pool, s3, config, job, &attempt_dir, &output_path).await;
    // Only this attempt's newly created UUID directory; never a volume or original.
    let _ = std::fs::remove_dir_all(&attempt_dir);
    result
}

async fn execute_job_files(
    pool: &PgPool,
    s3: &aws_sdk_s3::Client,
    config: &Config,
    job: &ClaimedJob,
    attempt_dir: &std::path::Path,
    output_path: &PathBuf,
) -> Result<(), String> {
    update_progress(pool, job, "preparing", 120).await?;
    let plan = crate::native_render::plan(&job.manifest)?;
    let mut inputs = std::collections::BTreeMap::new();
    let mut total_bytes = 0u64;
    for (index, hash) in plan.originals.iter().enumerate() {
        let mut tx = tenant_tx(pool, &job.tenant_id)
            .await
            .map_err(|error| error.message)?;
        let key: String = sqlx::query_scalar(
            "SELECT object_key FROM media_assets WHERE tenant_id=$1 AND asset_hash=$2",
        )
        .bind(&job.tenant_id)
        .bind(hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "manifest_asset_missing")?;
        tx.commit().await.map_err(|error| error.to_string())?;
        let response = s3
            .get_object()
            .bucket(&config.s3_bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| "source_download_failed")?;
        let mut body = response.body;
        let input_path = attempt_dir.join(format!("source-{index}.webm"));
        let mut input = File::create(&input_path).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = body.next().await {
            let bytes = chunk.map_err(|_| "source_download_failed")?;
            total_bytes += bytes.len() as u64;
            if total_bytes > 1024 * 1024 * 1024 {
                return Err("native_input_budget_exceeded".into());
            }
            hasher.update(&bytes);
            input.write_all(&bytes).map_err(|error| error.to_string())?;
        }
        if hex::encode(hasher.finalize()) != *hash {
            return Err("source_checksum_mismatch".into());
        }
        input.sync_all().map_err(|error| error.to_string())?;
        inputs.insert(hash.clone(), input_path);
    }
    update_progress(pool, job, "rendering", 300).await?;
    if is_cancelling(pool, job).await? {
        return cancel_job(pool, job).await;
    }

    let mut command = Command::new("ffmpeg");
    command.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-threads",
        "2",
        "-filter_complex_threads",
        "1",
    ]);
    for hash in &plan.assets {
        command
            .arg("-i")
            .arg(inputs.get(hash).ok_or("manifest_asset_missing")?);
    }
    if !plan.overlays.is_empty() {
        command
            .args([
                "-f",
                "rawvideo",
                "-pixel_format",
                "rgba",
                "-video_size",
                &format!(
                    "{}x{}",
                    job.manifest.canvas.width, job.manifest.canvas.height
                ),
                "-framerate",
                &plan.fps,
                "-i",
                "pipe:0",
            ])
            .stdin(Stdio::piped());
    }
    command
        .arg("-filter_complex")
        .arg(&plan.filters)
        .args([
            "-t",
            &plan.duration_seconds,
            "-r",
            &plan.fps,
            "-frames:v",
            &plan.frame_count.to_string(),
        ])
        .args([
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "good",
            "-cpu-used",
            "4",
            "-row-mt",
            "1",
            "-c:a",
            "libopus",
            "-f",
            "webm",
        ])
        .arg(output_path)
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| "codec_start_failed")?;
    let overlay_writer = if let Some(mut stdin) = child.stdin.take() {
        let manifest = job.manifest.clone();
        let sources = inputs.clone();
        let frames = plan.frame_count;
        Some(tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stream = render_plan::OverlayStream::new(&manifest)?;
            for index in 0..frames {
                let tick = (u128::from(index) * 48_000 * u128::from(manifest.fps_den)
                    / u128::from(manifest.fps_num)) as i64;
                let rgba = stream.frame(&manifest, tick, |hash| {
                    let path = sources.get(hash).ok_or("manifest_asset_missing")?;
                    if std::fs::metadata(path)
                        .map_err(|_| "logo_read_failed")?
                        .len()
                        > render_plan::MAX_LOGO_BYTES as u64
                    {
                        return Err("logo_byte_limit".into());
                    }
                    std::fs::read(path).map_err(|_| "logo_read_failed".into())
                })?;
                stdin
                    .write_all(rgba)
                    .await
                    .map_err(|_| "overlay_pipe_failed")?;
            }
            stdin.shutdown().await.map_err(|_| "overlay_pipe_failed")?;
            Ok::<(), String>(())
        }))
    } else {
        None
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.map_err(|_| "codec_wait_failed")?,
            _ = sleep(Duration::from_millis(750)) => {
                if is_cancelling(pool,job).await? { child.kill().await.map_err(|_| "codec_cancel_failed")?;return cancel_job(pool,job).await; }
                if tokio::time::Instant::now() >= deadline { child.kill().await.map_err(|_| "codec_timeout_failed")?;return Err("render_timeout".into()); }
                update_progress(pool,job,"rendering",500).await?;
            }
        }
    };
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}"));
    }
    if let Some(writer) = overlay_writer {
        writer.await.map_err(|_| "overlay_task_failed")??;
    }
    update_progress(pool, job, "verifying", 820).await?;
    if is_cancelling(pool, job).await? {
        return cancel_job(pool, job).await;
    }

    let (sha256, byte_length) = hash_file(output_path)?;
    let object_key = format!(
        "tenants/{}/artifacts/{}/{}-{}.webm",
        job.tenant_id,
        job.idempotency_key,
        job.attempt,
        Uuid::new_v4()
    );
    let body = ByteStream::from_path(output_path)
        .await
        .map_err(|error| error.to_string())?;
    s3.put_object()
        .bucket(&config.s3_bucket)
        .key(&object_key)
        .content_type("video/webm")
        .if_none_match("*")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("artifact upload failed: {error}"))?;
    update_progress(pool, job, "persisting", 950).await?;

    let mut tx = tenant_tx(pool, &job.tenant_id)
        .await
        .map_err(|error| error.message)?;
    let owns_lease: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND attempt=$4 AND state='running' AND lease_expires_at>now() FOR UPDATE)")
        .bind(&job.tenant_id).bind(&job.job_id).bind(&config.worker_id).bind(job.attempt).fetch_one(&mut *tx).await.map_err(|error| error.to_string())?;
    if !owns_lease {
        return Err("worker_lease_lost".into());
    }
    sqlx::query("INSERT INTO export_artifacts (tenant_id,id,job_id,idempotency_key,object_key,sha256,byte_length) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING")
        .bind(&job.tenant_id).bind(Uuid::new_v4()).bind(&job.job_id).bind(&job.idempotency_key).bind(&object_key).bind(&sha256).bind(byte_length as i64)
        .execute(&mut *tx).await.map_err(|error| error.to_string())?;
    sqlx::query("UPDATE jobs SET state='succeeded',phase='complete',progress_milli=1000,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3")
        .bind(&job.tenant_id).bind(&job.job_id).bind(&config.worker_id).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE job_attempts SET finished_at=now() WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3",
    )
    .bind(&job.tenant_id)
    .bind(&job.job_id)
    .bind(job.attempt)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

fn hash_file(path: &PathBuf) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total += count as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

async fn update_progress(
    pool: &PgPool,
    job: &ClaimedJob,
    phase: &str,
    progress: i32,
) -> Result<(), String> {
    let mut tx = tenant_tx(pool, &job.tenant_id)
        .await
        .map_err(|error| error.message)?;
    let updated = sqlx::query("UPDATE jobs SET state='running',phase=$3,progress_milli=$4,lease_expires_at=now()+interval '45 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$5 AND attempt=$6 AND state IN ('preparing','running') AND lease_expires_at>now()")
        .bind(&job.tenant_id).bind(&job.job_id).bind(phase).bind(progress).bind(&job.worker_id).bind(job.attempt).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("worker_lease_lost_or_cancelled".into());
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

async fn is_cancelling(pool: &PgPool, job: &ClaimedJob) -> Result<bool, String> {
    let mut tx = tenant_tx(pool, &job.tenant_id)
        .await
        .map_err(|error| error.message)?;
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM jobs WHERE tenant_id=$1 AND id=$2")
            .bind(&job.tenant_id)
            .bind(&job.job_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(state.as_deref() == Some("cancelling"))
}

async fn cancel_job(pool: &PgPool, job: &ClaimedJob) -> Result<(), String> {
    let mut tx = tenant_tx(pool, &job.tenant_id)
        .await
        .map_err(|error| error.message)?;
    sqlx::query("UPDATE jobs SET state='cancelled',phase='complete',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND attempt=$4 AND state='cancelling'")
        .bind(&job.tenant_id).bind(&job.job_id).bind(&job.worker_id).bind(job.attempt).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE job_attempts SET finished_at=now() WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3",
    )
    .bind(&job.tenant_id)
    .bind(&job.job_id)
    .bind(job.attempt)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

fn public_failure_code(message: &str) -> &'static str {
    match message {
        "source_download_failed" => "source_download_failed",
        "source_checksum_mismatch" => "source_checksum_mismatch",
        "native_input_budget_exceeded" => "native_input_budget_exceeded",
        "render_timeout" => "render_timeout",
        _ => "worker_failure",
    }
}

async fn fail_job(pool: &PgPool, job: &ClaimedJob, message: &str) -> Result<(), String> {
    // Provider errors can contain credentials, object keys or signed URLs.
    // Persist only the stable public category, never arbitrary provider text.
    let failure = serde_json::json!({"code":public_failure_code(message),"message":"Render attempt did not complete. Retry is available.","retryable":true});
    let mut tx = tenant_tx(pool, &job.tenant_id)
        .await
        .map_err(|error| error.message)?;
    let updated = sqlx::query("UPDATE jobs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'failed' END,phase='complete',failure=CASE WHEN state='cancelling' THEN NULL ELSE $3 END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$4 AND attempt=$5 AND state IN ('preparing','running','cancelling')")
        .bind(&job.tenant_id).bind(&job.job_id).bind(&failure).bind(&job.worker_id).bind(job.attempt).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    if updated.rows_affected() == 0 {
        return Ok(());
    }
    sqlx::query("UPDATE job_attempts SET finished_at=now(),failure=$4 WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3")
        .bind(&job.tenant_id).bind(&job.job_id).bind(job.attempt).bind(&failure).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}
