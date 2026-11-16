import { AESTHETIC_BLOCKS } from "../apps/client/src/ui/docblocks";
import { GENERATED_BLOCKS } from "../packages/shared/src/docgen";

/** Every generated documentation block: schema-derived (shared) + design tokens/icons (client). */
export const ALL_BLOCKS: Record<string, () => string> = { ...GENERATED_BLOCKS, ...AESTHETIC_BLOCKS };
