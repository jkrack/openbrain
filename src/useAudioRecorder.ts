import { useRef, useState, useCallback, useEffect } from "react";

export type RecordingState = "idle" | "recording" | "processing";

const SEGMENT_DURATION_SEC = 300; // 5 minutes

export interface AudioRecorderResult {
  state: RecordingState;
  duration: number;
  waveformData: number[];
  audioSegments: Blob[];
  segmentCount: number;
  error: string | null;
  startRecording: (deviceId?: string) => Promise<void>;
  stopRecording: () => Promise<Blob[]>;
  clearAudio: () => void;
  clearError: () => void;
}

/**
 * Enumerate available audio input devices (microphones).
 * Labels may be empty if microphone permission hasn't been granted yet.
 */
export async function getAudioDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export function useAudioRecorder(): AudioRecorderResult {
  const [state, setState] = useState<RecordingState>("idle");
  const [duration, setDuration] = useState(0);
  const [waveformData, setWaveformData] = useState<number[]>(new Array(40).fill(0));
  const [segments, setSegments] = useState<Blob[]>([]);
  const [segmentCount, setSegmentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const durationRef = useRef(0);
  const segmentElapsedRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("audio/webm");
  const rotatingRef = useRef(false);

  const updateWaveform = useCallback(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteTimeDomainData(data);

    const samples = 40;
    const step = Math.floor(data.length / samples);
    const points = Array.from({ length: samples }, (_, i) => {
      const val = data[i * step] / 128 - 1;
      return Math.abs(val);
    });

    setWaveformData(points);
    animFrameRef.current = requestAnimationFrame(updateWaveform);
  }, []);

  const startRecorderOnStream = useCallback((stream: MediaStream) => {
    const recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current });
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start(250);
  }, []);

  const finalizeCurrentSegment = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob([], { type: mimeTypeRef.current }));
        return;
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        chunksRef.current = [];
        resolve(blob);
      };

      recorder.stop();
    });
  }, []);

  const rotateSegment = useCallback(async () => {
    if (rotatingRef.current) return;
    rotatingRef.current = true;

    const blob = await finalizeCurrentSegment();
    if (blob.size > 0) {
      segmentsRef.current.push(blob);
      setSegmentCount(segmentsRef.current.length);
    }

    // Restart recording on the same mic stream
    const stream = streamRef.current;
    if (stream && stream.active) {
      startRecorderOnStream(stream);
      segmentElapsedRef.current = 0;
    }

    rotatingRef.current = false;
  }, [finalizeCurrentSegment, startRecorderOnStream]);

  const startRecording = useCallback(async (deviceId?: string) => {
    setError(null);

    try {
      let stream: MediaStream;

      // Try to get the specific device first, fall back to default if it fails
      if (deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId } },
          });
        } catch (deviceErr: any) {
          console.warn(
            `Mic device ${deviceId} unavailable (${deviceErr.message}), falling back to default mic`
          );
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      streamRef.current = stream;

      // Verify the stream has active audio tracks
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("No audio tracks available from microphone");
      }
      console.log(
        `Recording with mic: ${audioTracks[0].label || "Unknown"} (${audioTracks[0].readyState})`
      );

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;

      mimeTypeRef.current = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      segmentsRef.current = [];
      setSegments([]);
      setSegmentCount(0);
      segmentElapsedRef.current = 0;

      startRecorderOnStream(stream);
      setState("recording");
      durationRef.current = 0;
      setDuration(0);

      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        segmentElapsedRef.current += 1;
        setDuration(durationRef.current);

        // Auto-rotate at segment boundary
        if (segmentElapsedRef.current >= SEGMENT_DURATION_SEC) {
          rotateSegment();
        }
      }, 1000);

      animFrameRef.current = requestAnimationFrame(updateWaveform);
    } catch (err: any) {
      console.error("Failed to start recording:", err);
      const msg = err.name === "NotAllowedError"
        ? "Microphone permission denied. Grant access in System Settings > Privacy > Microphone."
        : err.name === "NotFoundError"
        ? "No microphone found. Connect an audio input device."
        : err.name === "OverconstrainedError"
        ? "Selected microphone not available. Try changing the device in Settings."
        : `Microphone error: ${err.message}`;
      setError(msg);
    }
  }, [updateWaveform, startRecorderOnStream, rotateSegment]);

  const stopRecording = useCallback(async (): Promise<Blob[]> => {
    setState("processing");

    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(animFrameRef.current);
    setWaveformData(new Array(40).fill(0));

    // Finalize the last segment
    const lastBlob = await finalizeCurrentSegment();
    if (lastBlob.size > 0) {
      segmentsRef.current.push(lastBlob);
    }

    // Stop all tracks
    streamRef.current?.getTracks().forEach((t) => t.stop());

    const allSegments = [...segmentsRef.current];
    setSegments(allSegments);
    setSegmentCount(allSegments.length);
    setState("idle");

    return allSegments;
  }, [finalizeCurrentSegment]);

  const clearAudio = useCallback(() => {
    setSegments([]);
    setSegmentCount(0);
    segmentsRef.current = [];
    setDuration(0);
    setWaveformData(new Array(40).fill(0));
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    state,
    duration,
    waveformData,
    audioSegments: segments,
    segmentCount,
    error,
    startRecording,
    stopRecording,
    clearAudio,
    clearError,
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
