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
  onAudioPromptChange,
  onToggleAudioPrompt,
  onSendAudio,
  formatDuration,
}: AudioControlsProps) {
  const tip = (text: string) => (showTooltips ? text : undefined);

  return (
    <>
      {/* Blue Steel recording state */}
      {isRecording && (
        <div className="ca-waveform">
          <div className="ca-waveform-chrome">
            <span className="ca-waveform-label">OpenBrain Recorder</span>
            {recorder.segmentCount > 0 && (
              <span className="ca-waveform-seg">SEG {recorder.segmentCount}</span>
            )}
          </div>
          <div className="ca-waveform-body">
            <span className="ca-rec-dot" />
            <div className="ca-waveform-display">
              <span className="ca-rec-time">{formatDuration(recorder.duration)}</span>
              <svg className="ca-wave-svg" viewBox="0 0 160 16" preserveAspectRatio="none">
                <polyline
                  className="ca-wave-line"
                  fill="none"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  points={recorder.waveformData
                    .map((v, i) => {
                      const x = (i / (recorder.waveformData.length - 1)) * 160;
                      const amp = Math.min(v * 48, 7);
                      const y = 8 - amp;
                      return `${x},${y}`;
                    })
                    .join(" ")}
                />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Audio ready state */}
      {hasAudio && !isRecording && (
        <div className="ca-audio-ready">
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
