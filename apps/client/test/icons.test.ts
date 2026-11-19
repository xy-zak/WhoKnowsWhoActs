import * as Iconoir from "iconoir-react";
import { describe, expect, it } from "vitest";
import { ICONS } from "../src/ui/Icon";
import { ICON_TABLE, type IconName } from "../src/ui/icons";

describe("semantic icon table", () => {
  it("maps every semantic name to the Iconoir icon documented in ICON_TABLE", () => {
    for (const [name, def] of Object.entries(ICON_TABLE) as Array<[IconName, { iconoir: string }]>) {
      const expected = (Iconoir as unknown as Record<string, unknown>)[def.iconoir];
      expect(expected, `iconoir-react has no ${def.iconoir}`).toBeDefined();
      expect(ICONS[name], `ICONS.${name}`).toBe(expected);
    }
  });
});
