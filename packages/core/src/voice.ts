/**
 * Portable dictation helpers: pause-based utterance segmentation, PCM
 * resampling, and WAV encoding. Dependency-free and safe in Node, browsers,
 * and edge runtimes, so a host can segment audio wherever it records it and
 * transcribe each utterance with `transcribeCodexAudio` from `./codex`.
 */
export * from "./voice/voiceActivity.js";
export * from "./voice/wavEncoding.js";
