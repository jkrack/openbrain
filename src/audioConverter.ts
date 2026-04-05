/**
 * Convert an audio Blob (WebM, etc.) to a 16kHz mono WAV Blob
 * using the Web Audio API (OfflineAudioContext).
 *
 * Required because the STT daemon uses Apple CoreAudio which
 * doesn't support WebM/Opus natively.
 */

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode the audio using a temporary context
  const tempCtx = new OfflineAudioContext(1, 1, 16000);
  const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

  // Resample to 16kHz mono
  const targetRate = 16000;
  const numSamples = Math.ceil(audioBuffer.duration * targetRate);
  const offlineCtx = new OfflineAudioContext(1, numSamples, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  const samples = rendered.getChannelData(0);

  // Encode as WAV
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let o = 0;

  writeString(view, o, "RIFF"); o += 4;
  view.setUint32(o, 36 + dataSize, true); o += 4;
  writeString(view, o, "WAVE"); o += 4;
  writeString(view, o, "fmt "); o += 4;
  view.setUint32(o, 16, true); o += 4;       // chunk size
  view.setUint16(o, 1, true); o += 2;        // PCM format
  view.setUint16(o, 1, true); o += 2;        // mono
  view.setUint32(o, targetRate, true); o += 4; // sample rate
  view.setUint32(o, targetRate * bytesPerSample, true); o += 4; // byte rate
  view.setUint16(o, bytesPerSample, true); o += 2; // block align
  view.setUint16(o, 16, true); o += 2;       // bits per sample
  writeString(view, o, "data"); o += 4;
  view.setUint32(o, dataSize, true); o += 4;

  // Write PCM samples
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
