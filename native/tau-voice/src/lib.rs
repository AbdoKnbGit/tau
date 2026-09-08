//! Minimal N-API 8 wrapper around OMP's MIT-licensed audio engine.
//! No local inference runtime, model downloads, Bun, or OMP addon dependency.

pub mod audio;
pub mod live;

use napi_derive::napi;

#[napi(js_name = "voiceAbiVersion")]
pub fn voice_abi_version() -> u32 {
    1
}
