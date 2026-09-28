// Cloudflare imports a compiled module; the same generated Rust glue is used by web.
import module from "../../rust/wasm/pkg/variantlab_wasm_bg.wasm";
import * as glue from "../../rust/wasm/pkg/variantlab_wasm_bg.js";
const instance = new WebAssembly.Instance(module, { "./variantlab_wasm_bg.js": glue });
glue.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
export const domain = glue;
