import React from "react";
import { AudioRecorderResult } from "../useAudioRecorder";
import { ObsidianIcon } from "./ObsidianIcon";

export interface AudioControlsProps {
  isRecording: boolean;
  hasAudio: boolean;
  isStreaming: boolean;
  recorder: AudioRecorderResult;
  audioPrompt: string;
  showAudioPrompt: boolean;
  showTooltips: boolean;
  isMobile: boolean;
  onAudioPromptChange: (val: string) => void;
  onToggleAudioPrompt: () => void;
  onSendAudio: () => void;
  formatDuration: (seconds: number) => string;
}

export function AudioControls({
  isRecording,
  hasAudio,
  isStreaming,
  recorder,
  audioPrompt,
  showAudioPrompt,
  showTooltips,
  isMobile,
  onAudioPromptChange,
  onToggleAudioPrompt,
  onSendAudio,
  formatDuration,
}: AudioControlsProps) {
  const tip = (text: string) => (showTooltips ? text : undefined);

  return (
    <>
      {/* Studio Monitor recording state */}
      {isRecording && (
        <div className={`ca-recorder${isMobile ? " ca-recorder--mobile" : ""}`}>
          {/* Row 1: Status — dot + timer | segment */}
          <div className="ca-recorder-status">
            <div className="ca-recorder-status-left">
              <span className="ca-rec-dot" />
              <span className={`ca-rec-time${isMobile ? " ca-rec-time--large" : ""}`}>{formatDuration(recorder.duration)}</span>
            </div>
            {recorder.segmentCount > 0 && (
              <span className="ca-rec-seg">SEG {recorder.segmentCount}</span>
            )}
          </div>
          {/* Row 2: Waveform */}
          <div className={`ca-recorder-wave${isMobile ? " ca-recorder-wave--large" : ""}`}>
            <svg className="ca-wave-svg" viewBox={isMobile ? "0 0 200 60" : "0 0 200 20"} preserveAspectRatio="none">
              <polyline
                className="ca-wave-line"
                fill="none"
                strokeWidth={isMobile ? "2.5" : "1.5"}
                strokeLinecap="round"
                points={recorder.waveformData
                  .map((v, i) => {
                    const x = (i / (recorder.waveformData.length - 1)) * 200;
                    const midY = isMobile ? 30 : 10;
                    const maxAmp = isMobile ? 27 : 9;
                    const amp = Math.min(v * 48, maxAmp);
                    const y = midY - amp;
                    return `${x},${y}`;
                  })
                  .join(" ")}
              />
            </svg>
          </div>
          {/* Row 3: Action bar */}
          <div className="ca-recorder-actions">
            <button className={`ca-recorder-stop${isMobile ? " ca-recorder-stop--large" : ""}`} onClick={() => recorder.stopRecording()}>
              <span className="ca-recorder-stop-icon" />
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Audio ready state */}
      {hasAudio && !isRecording && (
        <div className={`ca-audio-ready${isMobile ? " ca-audio-ready--mobile" : ""}`}>
          <span className="ca-audio-ready-label">
            Recording ready {"\u2014"} {formatDuration(recorder.duration)}
            {recorder.audioSegments.length > 1 && ` (${recorder.audioSegments.length} segments)`}
          </span>
          <div className="ca-audio-actions">
            {showAudioPrompt && (
              <input
                className="ca-audio-prompt-input"
                placeholder="Instructions (optional)"
                value={audioPrompt}
                onChange={(e) => onAudioPromptChange(e.target.value)}
                autoFocus
              />
            )}
            <button
              className="ca-icon-btn"
              onClick={onToggleAudioPrompt}
              aria-label={tip("Add instructions")}
            >
              <ObsidianIcon name="pencil" />
            </button>
            <button className="ca-icon-btn" onClick={recorder.clearAudio} aria-label={tip("Discard")}>
              <ObsidianIcon name="x" />
            </button>
            <button className="ca-send-btn" onClick={onSendAudio} disabled={isStreaming}>
              Send
            </button>
          </div>
        </div>
      )}

      {/* Mic error banner */}
      {recorder.error && (
        <div className="ca-mic-error">
          <span className="ca-mic-error-text">{recorder.error}</span>
          <button
            className="ca-icon-btn"
            onClick={() => recorder.clearError()}
            aria-label={tip("Dismiss")}
          >
            <ObsidianIcon name="x" />
          </button>
        </div>
      )}
    </>
  );
}
