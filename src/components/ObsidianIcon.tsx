import React, { useRef, useEffect } from "react";
import { setIcon } from "obsidian";

export function ObsidianIcon({ name, className }: { name: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.empty();
      setIcon(ref.current, name);
    }
  }, [name]);
  return <span ref={ref} className={`ca-icon ${className ?? ""}`} />;
}
