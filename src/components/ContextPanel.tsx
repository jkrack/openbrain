import { useState } from "react";
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
            {!state.activeContext ? (
              <div className="ob-detached-context-empty">No active context</div>
            ) : (
              <div className="ob-detached-context-item">
                {state.activeContext.split("/").pop()?.replace(/\.md$/, "") ?? state.activeContext}
              </div>
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
            {!state.graphContext ? (
              <div className="ob-detached-context-empty">No graph context</div>
            ) : (
              <div className="ob-detached-context-item">
                {state.graphContext}
              </div>
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
                  {t.status === "done" ? "✓" : t.status === "error" ? "✗" : "⏳"} {t.name}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
