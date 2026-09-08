# Tau native voice

Standalone extraction of the MIT-licensed Oh My Pi 18.0.10 `pi-voice` engine
and its thin N-API audio/live adapters. Original attribution is retained in
[LICENSE-OMP](./LICENSE-OMP). The OS backends and Opus/WebRTC media settings
are inherited from that implementation.

This addon contains no Gemini, Whisper, Kokoro, ONNX, Bun, OMP agent, or local
model installer. Tau supplies authenticated signaling and conversation control.
It targets N-API 8, compatible with Tau's Node 20.19 and 22.12 minimums.

## Build and distribution

From the repository root run `node scripts/build-native-voice.mjs` using stable
Rust, CMake, and the platform C/C++ compiler (MSVC build tools on Windows,
Xcode command-line tools on macOS, and a compiler/linker on Linux). Opus is
statically linked; no separate codec executable or model download is needed.
The checked-in Cargo.lock pins the standalone dependency graph. Windows builds
statically link both Opus and the MSVC C runtime; they require no separate
Visual C++ redistributable installation.

The build writes `bin/tau_voice.<platform>-<arch>.node`, using Node's platform
names (`win32`, `darwin`, `linux`). Release builders must build and collect all
supported platform/architecture binaries into that directory before publishing
the universal npm tarball. `TAU_VOICE_PLATFORM`, `TAU_VOICE_ARCH`, and
`TAU_VOICE_TARGET` select an explicit cross-compilation target; the host still
needs that target's compiler and Rust standard library. End users load the
prebuilt binary and do not compile Rust or install CMake. The package excludes
the Cargo build cache and private development tools.

Linux opens PulseAudio, falling back to ALSA, through runtime library loading;
the corresponding system audio service/library must be available. macOS uses
CoreAudio and Windows uses WASAPI. All use default microphone/speaker devices.

## Interface

- `voiceAbiVersion(): 1`
- `new AudioCapture(sampleRate, (error, samples: Float32Array) => void)`;
  `stop(): void` releases the microphone synchronously. `drain(): Promise<void>`
  waits for already queued JavaScript callbacks after stopping (one second
  timeout). It delivers an empty-sample sentinel through the same FIFO callback;
  ignore empty samples. Keep the released capture's callback generation valid
  until drain completes to preserve its tail, then gate microphone transmission.
  Full session cancellation invalidates generations immediately.
- `new AudioPlayback(sampleRate)`; `write(Float32Array)`, `setGain(number)`,
  `end(): Promise<void>` drains playback, `stop(): void` discards playback.
- `new LiveWebRtcPeer(onEvent, onLevel, onFailure)`; callbacks are error-first.
  `createOffer(): Promise<string>`, `acceptAnswer(sdp): Promise<void>`,
  `waitForOpen(timeoutMs?): Promise<void>`, `pushAudio(Float32Array)`,
  `setMuted(boolean)`, `clearOutput()`, `close(): Promise<void>`.

Live input is 16 kHz mono f32, encoded in 20 ms Opus frames. Decoded output is
48 kHz mono f32. The host must open capture only during intentional recording.
`setMuted(true)` gates new samples while already accepted samples finish
transmitting, preserving the release tail. A stalled producer is bounded to
two seconds of queued samples in each stage. Unlike OMP's original behavior,
muting does not clear recorded samples waiting on the media clock.

`clearOutput()` discards the current and queued application playback at the
next render callback without reconnecting. It cannot retract samples already
handed to the OS (typically up to three device periods; Linux remote audio can
buffer more). The host must also cancel remote generation: subsequently
arriving network packets are new audio and can play. Callback handles do not
keep Node alive after the terminal/session exits.

## Persistent tests

Run `cargo test --locked -p pi-voice --release` from this directory for playback
ordering/gain, drain accounting/device-loss wakeup, interruption, release-tail
preservation, bounded queues, native Opus encode/decode, and idempotent close.
Run `node --test native/tau-voice/test/addon.test.mjs` from the repository root
after building to validate the actual N-API artifact without opening audio
devices or contacting a service. Hardware smoke tests are ignored by default;
run with `-- --ignored` and opt in through `TAU_NATIVE_AUDIO_PLAYBACK_TEST=1`
or `TAU_NATIVE_AUDIO_CAPTURE_TEST=1`.
