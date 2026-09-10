//! One crop expression tree, evaluated by WASM or emitted for the native codec adapter.
//! Values are pixel-aligned cover rectangles. No input text enters codec expressions.
use serde::{Deserialize, Serialize};
use studio_model::{CanvasSpec, CropOverride};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderCropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone)]
enum Expr {
    W,
    H,
    N(f64),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Min(Box<Expr>, Box<Expr>),
    Max(Box<Expr>, Box<Expr>),
    Floor(Box<Expr>),
}
impl Expr {
    fn eval(&self, w: f64, h: f64) -> f64 {
        match self {
            Self::W => w,
            Self::H => h,
            Self::N(n) => *n,
            Self::Add(a, b) => a.eval(w, h) + b.eval(w, h),
            Self::Sub(a, b) => a.eval(w, h) - b.eval(w, h),
            Self::Mul(a, b) => a.eval(w, h) * b.eval(w, h),
            Self::Div(a, b) => a.eval(w, h) / b.eval(w, h),
            Self::Min(a, b) => a.eval(w, h).min(b.eval(w, h)),
            Self::Max(a, b) => a.eval(w, h).max(b.eval(w, h)),
            Self::Floor(a) => a.eval(w, h).floor(),
        }
    }
    fn codec(&self) -> String {
        match self {
            Self::W => "iw".into(),
            Self::H => "ih".into(),
            Self::N(n) => n.to_string(),
            Self::Add(a, b) => format!("({}+{})", a.codec(), b.codec()),
            Self::Sub(a, b) => format!("({}-{})", a.codec(), b.codec()),
            Self::Mul(a, b) => format!("({}*{})", a.codec(), b.codec()),
            Self::Div(a, b) => format!("({}/{})", a.codec(), b.codec()),
            Self::Min(a, b) => format!("min({},{})", a.codec(), b.codec()),
            Self::Max(a, b) => format!("max({},{})", a.codec(), b.codec()),
            Self::Floor(a) => format!("floor({})", a.codec()),
        }
    }
}
fn boxed(e: Expr) -> Box<Expr> {
    Box::new(e)
}
fn n(value: impl Into<f64>) -> Box<Expr> {
    boxed(Expr::N(value.into()))
}
fn expressions(canvas: CanvasSpec, crop: CropOverride) -> Result<[Expr; 4], String> {
    use Expr::*;
    if canvas.width == 0
        || canvas.height == 0
        || canvas.width > 16384
        || canvas.height > 16384
        || !(10000..=30000).contains(&crop.scale_basis_points)
        || !(-10000..=10000).contains(&crop.x_basis_points)
        || !(-10000..=10000).contains(&crop.y_basis_points)
    {
        return Err("invalid_render_crop".into());
    }
    let width = Max(
        n(1),
        boxed(Floor(boxed(Div(
            boxed(Mul(
                boxed(Min(
                    boxed(W),
                    boxed(Div(boxed(Mul(boxed(H), n(canvas.width))), n(canvas.height))),
                )),
                n(10000),
            )),
            n(crop.scale_basis_points),
        )))),
    );
    let height = Max(
        n(1),
        boxed(Floor(boxed(Div(
            boxed(Mul(
                boxed(Min(
                    boxed(H),
                    boxed(Div(boxed(Mul(boxed(W), n(canvas.height))), n(canvas.width))),
                )),
                n(10000),
            )),
            n(crop.scale_basis_points),
        )))),
    );
    let offset = |dimension: Expr, size: Expr, position: i16| {
        let remaining = Sub(boxed(dimension), boxed(size));
        Floor(boxed(Max(
            n(0),
            boxed(Min(
                boxed(remaining.clone()),
                boxed(Mul(
                    boxed(remaining),
                    boxed(Add(n(0.5), boxed(Div(n(position), n(10000))))),
                )),
            )),
        )))
    };
    Ok([
        offset(W, width.clone(), crop.x_basis_points),
        offset(H, height.clone(), crop.y_basis_points),
        width,
        height,
    ])
}
pub fn render_source_crop(
    canvas: CanvasSpec,
    crop: CropOverride,
    width: u32,
    height: u32,
) -> Result<RenderCropRect, String> {
    if width == 0 || height == 0 || width > 32768 || height > 32768 {
        return Err("invalid_source_dimensions".into());
    }
    let [x, y, w, h] =
        expressions(canvas, crop)?.map(|e| e.eval(width.into(), height.into()) as u32);
    Ok(RenderCropRect {
        x,
        y,
        width: w,
        height: h,
    })
}
pub fn native_crop_filter(canvas: CanvasSpec, crop: CropOverride) -> Result<String, String> {
    let [x, y, w, h] = expressions(canvas, crop)?.map(|e| e.codec());
    Ok(format!("crop=w='{w}':h='{h}':x='{x}':y='{y}':exact=1"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cover_is_not_stretch_and_offsets_are_bounded() {
        let c = CanvasSpec {
            width: 1080,
            height: 1920,
        };
        assert_eq!(
            render_source_crop(c, CropOverride::default(), 640, 360).unwrap(),
            RenderCropRect {
                x: 219,
                y: 0,
                width: 202,
                height: 360
            }
        );
        assert_eq!(
            render_source_crop(
                c,
                CropOverride {
                    x_basis_points: 5000,
                    y_basis_points: 0,
                    scale_basis_points: 20000
                },
                640,
                360
            )
            .unwrap(),
            RenderCropRect {
                x: 539,
                y: 90,
                width: 101,
                height: 180
            }
        );
        for position in [-10000, -5000, 0, 5000, 10000] {
            for (w, h) in [(640, 360), (360, 640), (1, 1), (1920, 1080)] {
                let r = render_source_crop(
                    c,
                    CropOverride {
                        x_basis_points: position,
                        y_basis_points: position,
                        scale_basis_points: 30000,
                    },
                    w,
                    h,
                )
                .unwrap();
                assert!(r.x + r.width <= w && r.y + r.height <= h);
            }
        }
    }
    #[test]
    fn invalid_geometry_never_produces_a_codec_program() {
        assert!(
            native_crop_filter(
                CanvasSpec {
                    width: 0,
                    height: 100
                },
                CropOverride::default()
            )
            .is_err()
        );
    }
}
