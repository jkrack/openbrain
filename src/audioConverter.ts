import { writeFile, unlink, rmdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const TARGET_SAMPLE_RATE = 16000;

/**
 * Convert a WebM/Opus audio Blob to a 16-bit PCM, mono, 16kHz WAV buffer.
 * Uses the browser's OfflineAudioContext (available in Electron) to decode
 * and resample — no external dependencies needed.
 */
export async function blobToWav(blob: Blob): Promise<Buffer> {
  const arrayBuffer = await blob.arrayBuffer();
  console.log(`[OpenBrain] blobToWav: blob size=${blob.size}, type="${blob.type}", arrayBuffer=${arrayBuffer.byteLength}`);

  // Decode the WebM/Opus blob using the browser's built-in decoder.
  // OfflineAudioContext needs at least 1 sample; we'll resample properly below.
  const tempCtx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

  console.log(`[OpenBrain] decoded AudioBuffer: duration=${audioBuffer.duration.toFixed(2)}s, sampleRate=${audioBuffer.sampleRate}, channels=${audioBuffer.numberOfChannels}, length=${audioBuffer.length}`);

  // Check if decoded audio has actual content
  const rawSamples = audioBuffer.getChannelData(0);
  let maxAmp = 0;
  for (let i = 0; i < rawSamples.length; i++) {
    const a = Math.abs(rawSamples[i]);
    if (a > maxAmp) maxAmp = a;
  }
  console.log(`[OpenBrain] decoded audio maxAmplitude=${maxAmp.toFixed(6)} (${maxAmp < 0.001 ? "SILENCE — no audio content" : "has audio content"})`);

  // Resample to 16kHz mono
  const samples = await resampleAudio(audioBuffer, TARGET_SAMPLE_RATE);

  // Check resampled audio
  let resampledMax = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > resampledMax) resampledMax = a;
  }
  console.log(`[OpenBrain] resampled: length=${samples.length}, maxAmplitude=${resampledMax.toFixed(6)}, duration=${(samples.length / TARGET_SAMPLE_RATE).toFixed(2)}s`);

  // Encode as WAV
  const wavBuffer = encodeWav(samples, TARGET_SAMPLE_RATE);
  console.log(`[OpenBrain] WAV encoded: ${wavBuffer.length} bytes`);
  return wavBuffer;
}

/**
 * Resample an AudioBuffer to the target rate and mix down to mono.
 * Uses OfflineAudioContext for high-quality resampling.
 */
async function resampleAudio(
  audioBuffer: AudioBuffer,
  targetRate: number
): Promise<Float32Array> {
  // If already at target rate and mono, return directly
  if (
    audioBuffer.sampleRate === targetRate &&
    audioBuffer.numberOfChannels === 1
  ) {
    return audioBuffer.getChannelData(0);
  }

  const duration = audioBuffer.duration;
  const numSamples = Math.ceil(duration * targetRate);
  const offlineCtx = new OfflineAudioContext(1, numSamples, targetRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Encode raw Float32 PCM samples as a 16-bit WAV buffer.
 * WAV format: 44-byte RIFF header + 16-bit signed integer PCM data.
 */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);
  let offset = 0;

  // RIFF header
  buffer.write("RIFF", offset);
  offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  buffer.write("WAVE", offset);
  offset += 4;

  // fmt sub-chunk
  buffer.write("fmt ", offset);
  offset += 4;
  buffer.writeUInt32LE(16, offset);
  offset += 4; // Sub-chunk size
  buffer.writeUInt16LE(1, offset);
  offset += 2; // PCM format
  buffer.writeUInt16LE(1, offset);
  offset += 2; // Mono
  buffer.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buffer.writeUInt32LE(sampleRate * bytesPerSample, offset);
  offset += 4; // Byte rate
  buffer.writeUInt16LE(bytesPerSample, offset);
  offset += 2; // Block align
  buffer.writeUInt16LE(16, offset);
  offset += 2; // Bits per sample

  // data sub-chunk
  buffer.write("data", offset);
  offset += 4;
  buffer.writeUInt32LE(dataSize, offset);
  offset += 4;

  // PCM samples — clamp float [-1, 1] to int16 [-32768, 32767]
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Write a WAV buffer to a temp file and return the path.
 * Caller must clean up via cleanupTempWav().
 */
export async function writeTempWav(wavBuffer: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openbrain-"));
  const filePath = join(dir, "audio.wav");
  await writeFile(filePath, wavBuffer);
  return filePath;
}

/**
 * Remove a temp WAV file and its parent directory.
 * Best-effort — won't throw if already cleaned up.
 */
export async function cleanupTempWav(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    await rmdir(join(filePath, ".."));
  } catch {
    // Best-effort cleanup
  }
}
