//! Filesystem transport for the existing native renderer. No domain decisions.
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::PathBuf};

pub async fn run() -> Result<(), String> {
    let root =
        PathBuf::from(std::env::var("VARIANTLAB_RENDER_DIR").map_err(|_| "render_dir_missing")?);
    let path = root.join("manifest.json");
    if std::fs::metadata(&path)
        .map_err(|_| "manifest_missing")?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("manifest_limit".into());
    }
    let manifest: render_plan::RenderManifest =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "manifest_missing")?)
            .map_err(|_| "manifest_invalid")?;
    let plan = crate::native_render::plan(&manifest)?;
    if std::env::var("VARIANTLAB_MODE").as_deref() == Ok("render-plan-file") {
        println!(
            "{}",
            serde_json::json!({"assets":plan.originals,"frame_count":plan.frame_count,"width":manifest.canvas.width,"height":manifest.canvas.height})
        );
        return Ok(());
    }
    let mut inputs = BTreeMap::new();
    let mut total = 0;
    for hash in plan.originals {
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("asset_hash_invalid".into());
        }
        let path = root.join(&hash);
        let mut file = std::fs::File::open(&path).map_err(|_| "asset_missing")?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|_| "asset_read_failed")?;
            if n == 0 {
                break;
            }
            total += n;
            if total > 1024 * 1024 * 1024 {
                return Err("native_input_budget_exceeded".into());
            }
            digest.update(&buffer[..n]);
        }
        if hex::encode(digest.finalize()) != hash {
            return Err("source_checksum_mismatch".into());
        }
        inputs.insert(hash, path);
    }
    crate::native_executor::execute(&manifest, &inputs, &root.join("output.webm"), || async {
        if root.join("cancel").exists() {
            Err("render_cancelled".into())
        } else {
            Ok(())
        }
    })
    .await
}
