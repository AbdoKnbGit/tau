# Voice conversation

Codex voice requires a **paid Codex plan**. A free Codex session cannot open
a call: OpenAI hides the realtime route from accounts without it, so the
attempt fails with 404 rather than an authorization error. Check the plan with
`/usage` before debugging anything else.

Run `/login openai` and select ChatGPT OAuth, then `/hey`. Choose the speaking
voice with `/models voice`; Sol is the default. Hold Space at the prompt to talk.
A red **● REC** and an input meter appear directly above the prompt while the
microphone is open. Release Space to stop capture. Most terminals expose key
repeats rather than key-up, so release is detected after 200 ms without a repeat.
A quick Space tap still types a space. A terminal that does not repeat keys
never reaches the hold threshold; rebind `hey:pushToTalk` to a modified key
such as `ctrl+space`, which activates on the first press instead. `/bye` closes the call, microphone and
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

## What a call costs

The voice model is `gpt-live-1-codex`, reached with the ChatGPT OAuth session
rather than an API key, so a call bills in two separate places:

| Work | Billed to |
| --- | --- |
| Speech, transcription, the voice model's replies | The Codex plan quota shown by `/usage` |
| Coding the call delegates to the agent | Whichever model `/models` has selected |

The voice model never edits code itself. It emits a delegation, Tau runs the
normal agent under the selected model and permission checks, and the result is
spoken back. Talking burns Codex quota; working burns the coding provider's.

Two bounds keep a call from hanging silently, both overridable:
`TAU_VOICE_CONNECT_TIMEOUT_MS` (default 30s) fails a stalled `/hey` and names
the step it stalled on, and `TAU_VOICE_DELEGATION_TIMEOUT_MS` (default 10min)
gives up on a delegated request that never reports back, instead of leaving the
call waiting on a result forever.

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

## Releasing the platform voice packages

The addon ships as six per-platform npm packages, `@abdoknbgit/tau-voice-<os>-<cpu>`,
each carrying `os` and `cpu` so npm installs only the one the host can load.
They live in `platform-packages/` and are deliberately **not** npm workspaces:
npm materialises every workspace regardless of `os`/`cpu` and fails with
`EBADPLATFORM` on the five that do not match the build host.

Release order matters, and the production shrinkwrap gate enforces it. Publish
the six platform packages **before** Tau itself; a Tau release whose optional
dependencies are not yet on the registry installs without voice and says so
rather than failing.

1. Collect the verified `native-voice.yml` artifact into `native/tau-voice/bin`
   and run `npm run voice:release-check`.
2. `node release/sync-voice-packages.mjs --binaries` — copies each binary into
   its package after checking it against the signed manifest, and writes the
   single-artifact manifest the runtime verifies against.
3. Publish all six from `platform-packages/`.
4. Only then add or bump the six entries in Tau's `optionalDependencies`,
   refresh the lockfile and production shrinkwrap, and publish Tau.

The addons carry their **own** version, in `release/voice-addon-version.json`,
not Tau's. Pins are exact, so sharing Tau's version would force six republishes
for every Tau release and make each one depend on having the built binaries to
hand. A Tau release that does not touch the audio engine therefore publishes
nothing extra and needs no binaries at all: `npm run release:voice -- --publish`
sees the addons already on the registry, skips straight past them and publishes
Tau alone.

Bump `release/voice-addon-version.json` only when the engine changes, then run
`node release/sync-voice-packages.mjs` to rewrite the six manifests and re-pin
Tau's `optionalDependencies`. A bump that updated only the version file would
leave Tau asking for the previous addons.

`npm run test:voice-packages` fails if the tracked manifests or those pins drift
from the root version, so a missed bump fails CI rather than a release. Nothing
here is per-machine: targets come from `process.platform`/`process.arch`, and
the one list of supported targets is asserted to match the runtime's. Binaries
stay untracked; only the manifests are committed.

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
