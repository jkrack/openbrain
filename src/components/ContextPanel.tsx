import { useState, useEffect } from "react";
import { OpenBrainSettings } from "../settings";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";

interface ContextPanelProps {
  settings: OpenBrainSettings;
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
}

export function ContextPanel({ settings, chatState, vaultIndex: _vaultIndex }: ContextPanelProps) {
  const [collapsed, setCollapsed] = useState(settings.contextPanelCollapsed);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    chatState.on("change", handler);
    return () => { chatState.off("change", handler); };
  }, [chatState]);

  const toggle = (section: "context" | "graph" | "tools") => {
    setCollapsed((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const state = chatState.getState();

  return (
    <div className="ob-detached-context">
      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("context")}>
          {collapsed.context ? "▸" : "▾"} Active Context
        </div>
        {!collapsed.context && (
          <div className="ob-detached-context-body">
            {state.activeContext.length === 0 ? (
              <div className="ob-detached-context-empty">No active context</div>
            ) : (
              state.activeContext.map((path) => (
                <div key={path} className="ob-detached-context-item">
                  {path.split("/").pop()?.replace(/\.md$/, "") ?? path}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("graph")}>
          {collapsed.graph ? "▸" : "▾"} Knowledge Graph
        </div>
        {!collapsed.graph && (
          <div className="ob-detached-context-body">
            {state.graphContext.length === 0 ? (
              <div className="ob-detached-context-empty">No graph context</div>
            ) : (
              state.graphContext.map((g) => (
                <div key={g.path} className="ob-detached-context-item">
                  {g.path.split("/").pop()?.replace(/\.md$/, "") ?? g.path}
                  <span className="ob-detached-context-meta"> hop {g.hop} · {g.relationship}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("tools")}>
          {collapsed.tools ? "▸" : "▾"} Tool Activity
        </div>
        {!collapsed.tools && (
          <div className="ob-detached-context-body">
            {state.toolActivity.length === 0 ? (
              <div className="ob-detached-context-empty">No tool activity</div>
            ) : (
              state.toolActivity.map((t) => (
                <div key={t.id} className={`ob-detached-tool-item ${t.status}`}>
                  {t.status === "complete" ? "✓" : t.status === "error" ? "✗" : "⏳"} {t.name}
                  {t.durationMs != null && <span className="ob-detached-context-meta">{t.durationMs}ms</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
