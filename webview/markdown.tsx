import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → sanitized HTML, with @Name mentions highlighted. */
export function renderMarkdown(text: string, names: string[]): string {
  const html = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'img'] });
  if (names.length === 0) return clean;
  const pattern = new RegExp(`(^|[\\s>(])@(all|${names.map(escapeRegex).join('|')})(?![\\w-])`, 'gi');
  return clean.replace(pattern, '$1<span class="mention">@$2</span>');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function Markdown({ text, names }: { text: string; names: string[] }) {
  const html = useMemo(() => renderMarkdown(text, names), [text, names.join('|')]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
