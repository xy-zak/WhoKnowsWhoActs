import { useEffect, useRef, useState } from "react";

/**
 * CRT connect/disconnect animation classes for a screen:
 *  - "signal-lost" while disconnected (flicker, then dimmed),
 *  - "signal-back" for a moment after reconnecting (power-on),
 *  - "" otherwise. Nothing happens before the first successful connection.
 */
export function useSignalClass(connected: boolean): string {
  const [cls, setCls] = useState("");
  const wasConnected = useRef(false);
  const lost = useRef(false);
  useEffect(() => {
    if (!connected) {
      if (wasConnected.current) {
        lost.current = true;
        setCls("signal-lost");
      }
      return;
    }
    if (wasConnected.current && lost.current) {
      lost.current = false;
      setCls("signal-back");
      const t = setTimeout(() => setCls(""), 320);
      return () => clearTimeout(t);
    }
    wasConnected.current = true;
  }, [connected]);
  return cls;
}
