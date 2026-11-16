import { marked } from "marked";
import { useMemo } from "react";

/** Renders trusted, local Markdown (consent/briefing texts from config/). */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false, gfm: true }) as string, [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: content comes from the researcher's local config files
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
