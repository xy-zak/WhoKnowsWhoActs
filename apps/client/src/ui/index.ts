import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/opendyslexic/400.css";
import "@fontsource/opendyslexic/700.css";
import "./theme.css";
import "./crt.css";

export * from "./components";
export { DisplaySettings, FONT_STACK } from "./DisplaySettings";
export { ICONS, Icon } from "./Icon";
export { ICON_TABLE, type IconName } from "./icons";
export { ConfirmProvider, isPopupOpen, Popup, type PopupProps, useConfirm } from "./Popup";
export {
  applyAppearance,
  type DisplayPrefs,
  defaultPrefs,
  FONT_LABEL,
  FONT_NAMES,
  type FontName,
  facilitatorPrefs,
  nextFont,
  nextScale,
  nextTheme,
  osTheme,
  type PrefsHandle,
  parsePrefs,
  playerPrefs,
  SCALE_LABEL,
  SCALE_NAMES,
  type ScaleName,
  useDisplayPrefs,
} from "./prefs";
export { type Shortcut, useShortcuts } from "./shortcuts";
export { useSignalClass } from "./signal";
export { type ToastMsg, ToastView } from "./Toast";
export { TooltipLayer } from "./Tooltip";
export { installThemeStyles, THEME_LABEL, THEME_NAMES, THEMES, type ThemeName } from "./tokens";
