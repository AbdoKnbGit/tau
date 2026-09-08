# Voice conversation

Run `/login openai` and select ChatGPT OAuth, then `/hey`. Choose the speaking
voice with `/models voice`; Sol is the default. Hold Space at the prompt to talk.
A red **● REC** and an input meter appear directly above the prompt while the
microphone is open. Release Space to stop capture. Most terminals expose key
repeats rather than key-up, so release is detected after 200 ms without a repeat.
A quick Space tap still types a space. `/bye` closes the call, microphone and
playback. Opening a dialog or leaving the prompt stops recording.

The voice model handles conversation and delegates coding requests to Tau's
normal agent. Your selected coding model, tools and permission checks remain in
effect. A `Heard:` preview shows the transcript. Transcripts alone do not launch
duplicate agent requests. Typed drafts are preserved when a voice request arrives.

Tau uses the native audio/Opus/WebRTC engine and Codex live protocol extracted
from OMP 18.0.10: 16 kHz mono microphone input, 20 ms Opus packets, 48 kHz decoded
speech, and `gpt-live-1-codex`. Actual speech quality and latency also depend on
the microphone, network and service. This is the Codex service used by OMP,
whose access and private protocol can change; copying its engine does not grant
account access. An OpenAI API key alone cannot replace the ChatGPT OAuth session.

## Installation and updates

Official releases bundle compiled audio components for Windows, macOS and glibc
Linux on x64 and arm64. End users do **not** need Rust, CMake, Visual Studio build
tools, Whisper, Gemini tooling, FFmpeg, or an installed Codex app. There are no
local speech-model downloads. The installer checks the bundled audio component;
updates receive the matching compiled version. Windows loads a verified cached
copy so an active call does not lock the package files during an update.

Users still need working default microphone/speaker devices, OS microphone
permission, internet access and a ChatGPT account with Codex voice access. Linux
needs PulseAudio or ALSA libraries and a working audio session. Musl Linux and
other CPU architectures are currently unsupported for voice; the rest of Tau
can still run. Missing or corrupted audio components produce a reinstall/update
error instead of starting a compiler installation.

Old Gemini/Whisper voice provider/model preferences are ignored. An old voice
such as `Kore` resolves to Sol. Ordinary Gemini coding credentials are preserved.
Run `/hey` again after restarting Tau or changing the voice to open a new call.

## Source builds and release checks

Contributors building audio from source need stable Rust, CMake and their OS
C/C++ compiler, then `npm run build:native-voice`. This is a release-builder
requirement, not an end-user dependency. `native/tau-voice/Cargo.lock` pins the
standalone engine dependencies. Opus and the Windows C runtime are statically
linked. See `native/tau-voice/README.md` and `LICENSE-OMP` for implementation and
attribution.

Run `npm run test:voice`, build the addon, and run
`node --test native/tau-voice/test/addon.test.mjs`. Native engine tests are
`cargo test --locked -p pi-voice --release` from `native/tau-voice`. These tests
exercise lifecycle, release-tail draining, Opus framing, keyboard controls,
OAuth, delegation correlation, `/resume`, and installer integrity without
recording the developer's microphone or contacting a live account.

The **Build native voice release artifacts** workflow builds and tests six
platform artifacts on native runners, then assembles a SHA-256 manifest. Collect
its universal artifact into `native/tau-voice/bin` and run
`npm run voice:release-check` before publishing. The publish gate rejects missing
platforms, wrong architecture and modified binaries. Successful unit tests do
not substitute for listening to a real microphone round trip on an entitled
account before claiming perceptual parity.
