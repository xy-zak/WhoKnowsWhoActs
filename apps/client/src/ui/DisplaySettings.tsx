import { type CSSProperties, useId } from "react";
import { type DisplayPrefs, FONT_LABEL, FONT_NAMES, type FontName, SCALE_LABEL, SCALE_NAMES } from "./prefs";
import { THEME_LABEL, THEME_NAMES } from "./tokens";

/** Font stacks, also used to preview each font option in its own face. */
export const FONT_STACK: Record<FontName, string> = {
  jetbrains: '"JetBrains Mono", ui-monospace, monospace',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

function Segmented<T extends string>({
  legend,
  options,
  value,
  label,
  onChange,
  preview,
}: {
  legend: string;
  options: readonly T[];
  value: T;
  label: (v: T) => string;
  onChange: (v: T) => void;
  preview?: (v: T) => CSSProperties;
}) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend>{legend}</legend>
      <div className="segmented-opts">
        {options.map((o) => (
          <label key={o} className={`segmented-opt${o === value ? " on" : ""}`} style={preview?.(o)}>
            <input type="radio" name={name} checked={o === value} onChange={() => onChange(o)} />
            {label(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The four display settings (accessibility). Used by the player's DISPLAY
 * panel and the facilitator's DISPLAY popup. Changes apply immediately and
 * stay in this browser; nothing is sent to the server.
 */
export function DisplaySettings({
  prefs,
  onChange,
}: {
  prefs: DisplayPrefs;
  onChange: (patch: Partial<DisplayPrefs>) => void;
}) {
  return (
    <div className="col display-settings">
      <Segmented
        legend="Colours"
        options={THEME_NAMES}
        value={prefs.theme}
        label={(t) => THEME_LABEL[t]}
        onChange={(theme) => onChange({ theme })}
      />
      <Segmented
        legend="Font"
        options={FONT_NAMES}
        value={prefs.font}
        label={(f) => FONT_LABEL[f]}
        onChange={(font) => onChange({ font })}
        preview={(f) => ({ fontFamily: FONT_STACK[f] })}
      />
      <Segmented
        legend="Text size"
        options={SCALE_NAMES}
        value={prefs.scale}
        label={(s) => SCALE_LABEL[s]}
        onChange={(scale) => onChange({ scale })}
      />
      <Segmented
        legend="Animations"
        options={["on", "off"] as const}
        value={prefs.animations ? "on" : "off"}
        label={(a) => (a === "on" ? "On" : "Off")}
        onChange={(a) => onChange({ animations: a === "on" })}
      />
    </div>
  );
}
