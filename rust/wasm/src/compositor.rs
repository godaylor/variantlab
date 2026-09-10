#![cfg(target_arch = "wasm32")]

use compositor::{Compositor, FrameDescriptor, RenderFrameOptions};
use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_serde_property, read_u32_property,
    with_gpu_runtime,
};
use crate::perf;

/// Isolated rendering instance owned by one preview, export, thumbnail, or editor surface.
#[wasm_bindgen]
pub struct CompositorSession {
    canvas: web_sys::HtmlCanvasElement,
    compositor: Compositor,
    surface: Option<wgpu::Surface<'static>>,
    surface_size: (u32, u32),
}

#[wasm_bindgen]
impl CompositorSession {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Result<CompositorSession, JsValue> {
        with_gpu_runtime(|gpu_runtime| {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is not available"))?;
            let canvas = document
                .create_element("canvas")?
                .dyn_into::<web_sys::HtmlCanvasElement>()
                .map_err(|_| JsValue::from_str("Failed to create compositor canvas"))?;
            canvas.set_width(width);
            canvas.set_height(height);

            let surface = if gpu_runtime.context.supports_surface_rendering() {
                let surface = gpu_runtime
                    .context
                    .instance()
                    .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                gpu_runtime
                    .context
                    .configure_surface(&surface, width, height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                Some(surface)
            } else {
                None
            };

            Ok(CompositorSession {
                canvas,
                compositor: Compositor::new(&gpu_runtime.context),
                surface,
                surface_size: (width, height),
            })
        })
    }

    #[wasm_bindgen(js_name = resize)]
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        if self.surface_size == (width, height) {
            return Ok(());
        }
        if let Some(surface) = self.surface.as_ref() {
            with_gpu_runtime(|gpu_runtime| {
                gpu_runtime
                    .context
                    .configure_surface(surface, width, height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))
            })?;
        }
        self.surface_size = (width, height);
        Ok(())
    }

    #[wasm_bindgen(js_name = canvas)]
    pub fn canvas(&self) -> web_sys::HtmlCanvasElement {
        self.canvas.clone()
    }

    #[wasm_bindgen(js_name = uploadTexture)]
    pub fn upload_texture(&mut self, options: JsValue) -> Result<(), JsValue> {
        let UploadTextureOptions {
            id,
            source,
            width,
            height,
        } = parse_upload_texture_options(options)?;
        with_gpu_runtime(|gpu_runtime| {
            let texture = import_canvas_texture(
                &gpu_runtime.context,
                &source,
                width,
                height,
                "compositor-upload-texture",
            );
            self.compositor.upsert_texture(id, texture);
            Ok(())
        })
    }

    #[wasm_bindgen(js_name = releaseTexture)]
    pub fn release_texture(&mut self, id: String) {
        self.compositor.release_texture(&id);
    }

    #[wasm_bindgen(js_name = renderFrame)]
    pub fn render_frame(&mut self, options: JsValue) -> Result<(), JsValue> {
        perf::reset();
        let t_deserialize = perf::now_ms();
        let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
            .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;
        perf::record("wasm.deserialize", perf::now_ms() - t_deserialize);

        if self.surface_size != (frame.width, frame.height) {
            self.resize(frame.width, frame.height)?;
        }

        with_gpu_runtime(|gpu_runtime| {
            if let Some(surface) = self.surface.as_ref() {
                let t_render = perf::now_ms();
                let result = self
                    .compositor
                    .render_frame(
                        &gpu_runtime.context,
                        RenderFrameOptions {
                            frame: &frame,
                            surface,
                        },
                    )
                    .map_err(|error| JsValue::from_str(&error.to_string()));
                perf::record("wasm.renderFrameToSurface", perf::now_ms() - t_render);
                return result;
            }

            let t_composite = perf::now_ms();
            let texture = self
                .compositor
                .render_frame_to_texture(&gpu_runtime.context, &frame)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            perf::record("wasm.compositeToTexture", perf::now_ms() - t_composite);

            let t_present = perf::now_ms();
            gpu_runtime
                .context
                .render_texture_via_gl_canvas(&texture, &self.canvas, frame.width, frame.height)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            perf::record("wasm.presentToOwnedCanvas", perf::now_ms() - t_present);
            Ok(())
        })
    }
}

#[derive(Debug)]
struct UploadTextureOptions {
    id: String,
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
}

fn parse_upload_texture_options(value: JsValue) -> Result<UploadTextureOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTexture expects an options object"))?;
    Ok(UploadTextureOptions {
        id: read_serde_property(&object, "id")?,
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}
