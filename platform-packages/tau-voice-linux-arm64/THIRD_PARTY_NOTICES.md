# Third-party notices

The native audio/WebRTC engine and its N-API adapters are adapted from Oh My Pi
18.0.10, `crates/pi-voice` and `crates/pi-natives/src/{audio,live}.rs`. Tau's live
wire protocol and voice list are also adapted from that project's
`packages/coding-agent/src/live` implementation. The original MIT license and
copyright notices are preserved verbatim in [LICENSE-OMP](./LICENSE-OMP).

Tau changes isolate this engine from the OMP native addon, target N-API 8,
preserve admitted microphone samples on push-to-talk release, add a bounded
JavaScript callback drain barrier and queued playback cancellation, and add
hardware-independent regression tests and portable build/release packaging.

The statically linked Opus codec's original copyright and license text is
preserved in [LICENSE-OPUS](./LICENSE-OPUS). The Rust/WebRTC dependency graph
retains its package licenses; exact versions and checksums are recorded in
[Cargo.lock](./Cargo.lock).
