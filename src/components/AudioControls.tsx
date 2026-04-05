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
      {/* ── Recording: VU strip ── */}
      {isRecording && (
        <div className={`ca-vu${isMobile ? " ca-vu--mobile" : ""}`}>
          <div className="ca-vu-track">
            <span className="ca-vu-beacon" />
            <span className="ca-vu-time">{formatDuration(recorder.duration)}</span>
            {recorder.segmentCount > 0 && (
              <span className="ca-vu-seg">{recorder.segmentCount}</span>
            )}
            <div className="ca-vu-meter">
              <svg className="ca-vu-svg" viewBox="0 0 120 16" preserveAspectRatio="none">
                {recorder.waveformData.map((v, i) => {
                  const x = (i / recorder.waveformData.length) * 120;
                  const barW = 120 / recorder.waveformData.length - 0.5;
                  const h = Math.max(1.5, Math.min(v * 40, 14));
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={8 - h / 2}
                      width={Math.max(barW, 1)}
                      height={h}
                      rx="0.5"
                      className="ca-vu-bar"
                    />
                  );
                })}
              </svg>
            </div>
            <button
              className="ca-vu-stop"
              onClick={() => recorder.stopRecording()}
              aria-label={tip("Stop recording")}
            >
              <span className="ca-vu-stop-square" />
            </button>
          </div>
        </div>
      )}

      {/* ── Audio ready: review strip ── */}
      {hasAudio && !isRecording && (
        <div className={`ca-vu ca-vu--ready${isMobile ? " ca-vu--mobile" : ""}`}>
          <div className="ca-vu-track">
            <span className="ca-vu-ready-icon">
              <ObsidianIcon name="mic" />
            </span>
            <span className="ca-vu-time ca-vu-time--ready">
              {formatDuration(recorder.duration)}
              {recorder.audioSegments.length > 1 && (
                <span className="ca-vu-seg-inline"> / {recorder.audioSegments.length} seg</span>
              )}
            </span>
            <div className="ca-vu-spacer" />
            {showAudioPrompt && (
              <input
                className="ca-vu-prompt"
                placeholder="Instructions..."
                value={audioPrompt}
                onChange={(e) => onAudioPromptChange(e.target.value)}
                autoFocus
              />
            )}
            <button
              className="ca-vu-action"
              onClick={onToggleAudioPrompt}
              aria-label={tip("Add instructions")}
            >
              <ObsidianIcon name="pencil" />
            </button>
            <button
              className="ca-vu-action"
              onClick={recorder.clearAudio}
              aria-label={tip("Discard")}
            >
              <ObsidianIcon name="x" />
            </button>
            <button
              className="ca-vu-send"
              onClick={onSendAudio}
              disabled={isStreaming}
            >
              <ObsidianIcon name="arrow-up" />
            </button>
          </div>
        </div>
      )}

      {/* ── Mic error ── */}
      {recorder.error && (
        <div className="ca-vu ca-vu--error">
          <div className="ca-vu-track">
            <span className="ca-vu-error-text">{recorder.error}</span>
            <button
              className="ca-vu-action"
              onClick={() => recorder.clearError()}
              aria-label={tip("Dismiss")}
            >
              <ObsidianIcon name="x" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
