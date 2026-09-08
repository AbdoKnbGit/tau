//! N-API bindings for microphone capture and speaker playback.
//!
//! The engine — device discovery, format conversion, mixing, drain semantics —
//! lives in `pi_voice::audio`; these classes adapt its mono `f32` contract to
//! TypeScript callbacks and `Float32Array` buffers.

use std::sync::Arc;

use napi::{
    bindgen_prelude::{Float32Array, Result},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_voice::audio::{CaptureStream, PlaybackState, PlaybackStream};

// Tau's terminal/WebSocket owns process lifetime. Idle native callback handles
// must not keep Node alive after /bye or when a caller drops the last peer.
type CaptureCallback =
    ThreadsafeFunction<Float32Array, UnknownReturnValue, Float32Array, napi::Status, true, true>;

/// Default-microphone capture converted to mono `f32` at the requested sample
/// rate.
#[napi]
pub struct AudioCapture {
    stream: Mutex<Option<CaptureStream>>,
    on_audio: Mutex<Option<Arc<CaptureCallback>>>,
}

#[napi]
impl AudioCapture {
    /// Open the default microphone and deliver low-latency mono PCM chunks.
    #[napi(constructor)]
    pub fn new(
        sample_rate: u32,
        #[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
        on_audio: CaptureCallback,
    ) -> Result<Self> {
        let on_audio = Arc::new(on_audio);
        let callback = Arc::clone(&on_audio);
        let stream = CaptureStream::start(sample_rate, move |samples| {
            callback.call(
                Ok(Float32Array::new(samples.to_vec())),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        })
        .map_err(napi::Error::from_reason)?;
        Ok(Self {
            stream: Mutex::new(Some(stream)),
            on_audio: Mutex::new(Some(on_audio)),
        })
    }

    /// Stop capture immediately and release the microphone.
    #[napi]
    pub fn stop(&self) -> Result<()> {
        let stream = self.stream.lock().take();
        let Some(mut stream) = stream else {
            return Ok(());
        };
        stream.stop().map_err(napi::Error::from_reason)
    }

    /// After stop(), wait for all PCM already queued to JavaScript. The empty
    /// sentinel shares the same FIFO callback, so its return is an exact drain
    /// barrier without copying audio into a second buffer. The host ignores
    /// empty samples and keeps accepting this capture's tail until resolution.
    #[napi]
    pub async fn drain(&self) -> Result<()> {
        if self.stream.lock().is_some() {
            return Err(napi::Error::from_reason(
                "Stop audio capture before draining callbacks",
            ));
        }
        let Some(callback) = self.on_audio.lock().take() else {
            return Ok(());
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            callback.call_async(Ok(Float32Array::new(Vec::new()))),
        )
        .await
        .map_err(|_| napi::Error::from_reason("Timed out draining microphone callbacks"))??;
        Ok(())
    }
}

/// Gapless mono `f32` playback through the default speaker.
#[napi]
pub struct AudioPlayback {
    stream: Mutex<Option<PlaybackStream>>,
    state: Arc<PlaybackState>,
}

#[napi]
impl AudioPlayback {
    /// Open the default speaker at the requested logical sample rate.
    #[napi(constructor)]
    pub fn new(sample_rate: u32) -> Result<Self> {
        let stream = PlaybackStream::start(sample_rate).map_err(napi::Error::from_reason)?;
        let state = stream.state();
        Ok(Self {
            stream: Mutex::new(Some(stream)),
            state,
        })
    }

    /// Queue mono floating-point PCM in playback order.
    #[napi]
    pub fn write(&self, samples: Float32Array) -> Result<()> {
        let stream = self.stream.lock();
        let stream = stream
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
        stream
            .writer()
            .and_then(|writer| writer.write(&samples))
            .map_err(napi::Error::from_reason)
    }

    /// Scale audio at render time so gain changes affect already queued samples.
    #[napi]
    pub fn set_gain(&self, gain: f64) -> Result<()> {
        let stream = self.stream.lock();
        let stream = stream
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
        stream
            .set_gain(gain as f32)
            .map_err(napi::Error::from_reason)
    }

    /// Close input, wait until queued samples reach the speaker, then release
    /// it.
    #[napi]
    pub async fn end(&self) -> Result<()> {
        {
            let mut stream = self.stream.lock();
            let Some(stream) = stream.as_mut() else {
                return Ok(());
            };
            stream.finish_input();
        }
        self.state.wait_for_drain().await;
        let stream = self.stream.lock().take();
        if let Some(mut stream) = stream {
            stream.stop().map_err(napi::Error::from_reason)?;
        }
        Ok(())
    }

    /// Stop immediately and discard all queued samples.
    #[napi]
    pub fn stop(&self) -> Result<()> {
        let stream = self.stream.lock().take();
        if let Some(mut stream) = stream {
            stream.stop().map_err(napi::Error::from_reason)?;
        }
        Ok(())
    }
}
