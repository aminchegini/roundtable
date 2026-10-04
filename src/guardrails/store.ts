import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { GuardrailDef, GuardrailsFile, Preset, ProjectProfile } from './types';

export { selectPreset, setGuardrailConfig, toggleGuardrail } from '../shared/guardrailsFile';

const overrideSchema = z.union([z.literal(true), z.record(z.string(), z.unknown())]);
const fileSchema = z.object({
  preset: z.string().optional(),
  enabled: z.record(z.string(), overrideSchema).default({}),
  disabled: z.array(z.string()).default([]),
});

export const EMPTY_FILE: GuardrailsFile = { enabled: {}, disabled: [] };

function filePath(root: string): string {
  return path.join(root, '.roundtable', 'guardrails.json');
}

export async function loadGuardrailsFile(root: string): Promise<GuardrailsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath(root), 'utf8');
  } catch {
    return { ...EMPTY_FILE };
  }
  const parsed = fileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid ${filePath(root)}: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  return parsed.data;
}

export async function saveGuardrailsFile(root: string, file: GuardrailsFile): Promise<void> {
  const target = filePath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(file, null, 2)}\n`);
}

export interface EffectiveGuardrail {
  def: GuardrailDef;
  config: Record<string, unknown>;
}

/**
 * Effective set: the preset's guardrails, minus `disabled`, plus `enabled`.
 * Config = defaults(profile) ← preset overrides ← user overrides.
 */
export function resolveGuardrails(
  file: GuardrailsFile,
  presets: Preset[],
  catalog: GuardrailDef[],
  profile: ProjectProfile,
): EffectiveGuardrail[] {
  const preset = presets.find((p) => p.id === file.preset);
  const ids = new Set<string>([...Object.keys(preset?.guardrails ?? {}), ...Object.keys(file.enabled)]);
  for (const id of file.disabled) ids.delete(id);

  const result: EffectiveGuardrail[] = [];
  for (const def of catalog) {
    if (!ids.has(def.id) || !def.appliesTo(profile)) continue;
    const presetOverride = preset?.guardrails[def.id];
    const userOverride = file.enabled[def.id];
    const config = {
      ...(def.defaults(profile) as Record<string, unknown>),
      ...(typeof presetOverride === 'object' ? presetOverride : {}),
      ...(typeof userOverride === 'object' ? userOverride : {}),
    };
    result.push({ def, config });
  }
  return result;
}

/** Config a guardrail would have if enabled, for the settings form. */
export function previewConfig(file: GuardrailsFile, presets: Preset[], def: GuardrailDef, profile: ProjectProfile): Record<string, unknown> {
  const preset = presets.find((p) => p.id === file.preset);
  const presetOverride = preset?.guardrails[def.id];
  const userOverride = file.enabled[def.id];
  return {
    ...(def.defaults(profile) as Record<string, unknown>),
    ...(typeof presetOverride === 'object' ? presetOverride : {}),
    ...(typeof userOverride === 'object' ? userOverride : {}),
  };
}
