use std::{collections::BTreeMap, future::Future, path::PathBuf, process::Stdio};
use tokio::{
    process::Command,
    time::{Duration, sleep},
};

/// Shared native execution for the Postgres worker and the Sites transport.
pub async fn execute<F, T>(
    manifest: &render_plan::RenderManifest,
    inputs: &BTreeMap<String, PathBuf>,
    output_path: &PathBuf,
    mut tick: F,
) -> Result<(), String>
where
    F: FnMut() -> T,
    T: Future<Output = Result<(), String>>,
{
    let plan = crate::native_render::plan(manifest)?;
    let mut command = Command::new("ffmpeg");
    command
        .env_clear()
        .env("PATH", "/opt/ffmpeg/bin:/usr/bin:/bin");
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
                &format!("{}x{}", manifest.canvas.width, manifest.canvas.height),
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
        let manifest = manifest.clone();
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
                tick().await?;
                if tokio::time::Instant::now() >= deadline { child.kill().await.map_err(|_| "codec_timeout_failed")?;return Err("render_timeout".into()); }

            }
        }
    };
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}"));
    }
    if let Some(writer) = overlay_writer {
        writer.await.map_err(|_| "overlay_task_failed")??;
    }
    Ok(())
}
