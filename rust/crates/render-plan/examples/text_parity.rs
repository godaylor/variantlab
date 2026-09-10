use render_plan::{
    INTER_FONT_ID, INTER_SHA256, RENDER_ENGINE_VERSION, RenderManifest, raster_manifest_text,
    render_overlays,
};
use sha2::{Digest, Sha256};
fn main() {
    let manifest: RenderManifest = serde_json::from_value(serde_json::json!({
        "schema_version":1,"engine_version":RENDER_ENGINE_VERSION,"campaign_revision":1,"master_sequence_id":"parity",
        "scenes":[{"scene_id":"s","scene_revision":1,"included":true,"start_tick":0,"duration_ticks":48000}],"clips":[],
        "sequence_duration_ticks":48000,"variant_fingerprint":"repository-owned-text-parity","canvas":{"width":640,"height":360},"fps_num":30,"fps_den":1,
        "safe_area":{"top_basis_points":0,"right_basis_points":0,"bottom_basis_points":0,"left_basis_points":0},"crop":{"x_basis_points":0,"y_basis_points":0,"scale_basis_points":10000},
        "asset_hashes":[],"font_revisions":[],"fps_source":"master","audio_mix_source":"master",
        "slot_nodes":[{"slot_id":"headline","value":{"kind":"text","text":"Привет VariantLab <>&"},"target":{"kind":"overlay","scene_id":"s","start_ticks":12000,"end_ticks":36000,"rect":{"x":1000,"y":1000,"width":8000,"height":4000},"z_index":1,"text_style":{"font_id":INTER_FONT_ID,"font_sha256":INTER_SHA256,"font_size_px":24,"line_height_px":32,"max_lines":3,"color_rgba":[230,100,30,180],"alignment":"center"}}}]
    })).unwrap();
    let pixels = raster_manifest_text(&manifest, "headline").unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_fn(9, 5, |x, y| {
        image::Rgba([
            (x * 27) as u8,
            (y * 50) as u8,
            80,
            if x % 2 == 0 { 170 } else { 255 },
        ])
    })
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
    let png = png.into_inner();
    let probe = render_plan::probe_logo_png(&png).unwrap();
    let mut logo_manifest = manifest.clone();
    logo_manifest.slot_nodes[0].value = studio_model::SlotValue::Logo {
        asset_id: probe.sha256.clone(),
    };
    if let studio_model::SlotRenderTarget::Overlay { text_style, .. } =
        &mut logo_manifest.slot_nodes[0].target
    {
        *text_style = None;
    }
    let logo_pixels = render_plan::raster_manifest_logo(&logo_manifest, "headline", &png).unwrap();
    let mut stress = manifest.clone();
    stress.sequence_duration_ticks = 120_000_000;
    stress.scenes[0].duration_ticks = stress.sequence_duration_ticks;
    let template = stress.slot_nodes.remove(0);
    for index in 0..1000 {
        let mut cue = template.clone();
        cue.slot_id = format!("caption-{index}");
        cue.value = studio_model::SlotValue::Text {
            text: format!("Реплика {index} / Caption {index}"),
        };
        if let studio_model::SlotRenderTarget::Overlay {
            start_ticks,
            end_ticks,
            ..
        } = &mut cue.target
        {
            *start_ticks = index * 120_000;
            *end_ticks = (index + 1) * 120_000 - 4800;
        }
        stress.slot_nodes.push(cue);
    }
    let mut stream = render_plan::OverlayStream::new(&stress).unwrap();
    let mut stress_samples = Vec::new();
    for index in [0, 1, 31, 32, 499, 999] {
        stream
            .frame(&stress, index * 120_000, |_| Err("no logos".into()))
            .unwrap();
        let pixels =
            render_plan::raster_manifest_text(&stress, &format!("caption-{index}")).unwrap();
        stress_samples.push(serde_json::json!({"index":index,"sha256":format!("{:x}",Sha256::digest(&pixels)),"cached_bytes":stream.cached_bytes()}));
    }
    println!(
        "{}",
        serde_json::json!({"manifest":manifest,"overlays":render_overlays(&manifest).unwrap(),"pixel_sha256":format!("{:x}",Sha256::digest(&pixels)),"byte_length":pixels.len(),"logo":{"manifest":logo_manifest,"png":png,"probe":probe,"pixel_sha256":format!("{:x}",Sha256::digest(&logo_pixels)),"byte_length":logo_pixels.len()},"stress":{"manifest":stress,"samples":stress_samples}})
    );
}
