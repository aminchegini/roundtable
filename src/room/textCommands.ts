/**
 * Provider-neutral room protocol carried in an agent's final reply, for
 * providers that cannot call Roundtable's in-process tools. Claude agents have
 * the tools and may use either form.
 */
export interface ParsedReply {
  /** Reply without the command lines; what gets posted to the room. */
  text: string;
  /** The whole reply was `PASS` (nothing to add). */
  passed: boolean;
  /** `APPROVE: <summary>` line (reviewer veto). */
  approve?: string;
  /** Contents of a `SPEC:` block (spec-first). */
  spec?: string;
}

const PASS_RE = /^\s*(?:\*\*)?PASS(?:\*\*)?\.?\s*$/i;
const APPROVE_RE = /^\s*(?:\*\*)?APPROVE(?:\*\*)?\s*:\s*(.+?)\s*$/im;
/** `SPEC:` on its own line, followed by either a fenced block or everything to the end. */
const SPEC_RE = /^\s*(?:\*\*)?SPEC(?:\*\*)?\s*:\s*\n(?:```[a-z]*\n([\s\S]*?)\n```|([\s\S]*))/im;

export function parseReply(raw: string): ParsedReply {
  const text = raw.trim();
  if (PASS_RE.test(text)) return { text: '', passed: true };

  let rest = text;
  let approve: string | undefined;
  let spec: string | undefined;

  const specMatch = SPEC_RE.exec(rest);
  if (specMatch) {
    spec = (specMatch[1] ?? specMatch[2] ?? '').trim();
    rest = (rest.slice(0, specMatch.index) + rest.slice(specMatch.index + specMatch[0].length)).trim();
  }
  const approveMatch = APPROVE_RE.exec(rest);
  if (approveMatch) {
    approve = approveMatch[1]?.trim();
    rest = (rest.slice(0, approveMatch.index) + rest.slice(approveMatch.index + approveMatch[0].length)).trim();
  }
  return { text: rest, passed: false, approve, spec };
}

/** Prompt text explaining the protocol to an agent without room tools. */
export function textProtocolPrompt(opts: { reviewer: boolean; specFirst: boolean }): string {
  const lines = ['If you have nothing new to add, reply with exactly the single word PASS.'];
  if (opts.reviewer) lines.push('To approve the current plan so others may edit, put a line `APPROVE: <one-sentence summary>` in your reply.');
  if (opts.specFirst) lines.push('To submit a spec for the user to approve, end your reply with a line `SPEC:` followed by the spec in a fenced markdown block.');
  return lines.join('\n');
}
