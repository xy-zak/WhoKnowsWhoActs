import { table } from "@wkwa/shared";
import { ICON_TABLE } from "./icons";
import { CONTRAST_PAIRS, contrast, THEMES, TOKEN_DOCS } from "./tokens";

/** Generated blocks for docs/AESTHETIC-RULES.md (pure data, no DOM). */
export const AESTHETIC_BLOCKS: Record<string, () => string> = {
  "aesthetic-tokens": () =>
    table(
      ["Token", "Role", "Latte (light)", "Mocha (dark)", "High contrast"],
      TOKEN_DOCS.map((d) => [
        `\`${d.token}\``,
        d.role,
        `\`${d.latte}\``,
        `\`${d.mocha}\``,
        `\`${d.contrast}\``,
      ]),
    ),
  "aesthetic-contrast": () =>
    table(
      ["Foreground", "Background", "Minimum", "Latte", "Mocha", "High contrast"],
      CONTRAST_PAIRS.map(([fg, bg, min]) => [
        `\`--${fg}\``,
        `\`--${bg}\``,
        `${min}:1`,
        `${contrast(THEMES.latte[fg]!, THEMES.latte[bg]!).toFixed(2)}:1`,
        `${contrast(THEMES.mocha[fg]!, THEMES.mocha[bg]!).toFixed(2)}:1`,
        `${contrast(THEMES.contrast[fg]!, THEMES.contrast[bg]!).toFixed(2)}:1`,
      ]),
    ),
  "aesthetic-icons": () =>
    table(
      ["Name (`<Icon name>`)", "Iconoir icon", "Used for"],
      Object.entries(ICON_TABLE).map(([k, v]) => [`\`${k}\``, `\`${v.iconoir}\``, v.meaning]),
    ),
};
