import type { GuardrailsFile } from './protocol';

/** Pure edits to `.roundtable/guardrails.json`, shared by host and webview. */

export function selectPreset(file: GuardrailsFile, presetId: string | undefined): GuardrailsFile {
  // Switching preset drops individual overrides: the preset is the new baseline.
  return { preset: presetId, enabled: {}, disabled: [] };
}

export function toggleGuardrail(file: GuardrailsFile, presetIds: string[], id: string, on: boolean): GuardrailsFile {
  const inPreset = presetIds.includes(id);
  const enabled = { ...file.enabled };
  let disabled = file.disabled.filter((d) => d !== id);
  if (on) {
    if (!inPreset && !enabled[id]) enabled[id] = true;
  } else {
    delete enabled[id];
    if (inPreset) disabled = [...disabled, id];
  }
  return { ...file, enabled, disabled };
}

export function setGuardrailConfig(file: GuardrailsFile, id: string, config: Record<string, unknown>): GuardrailsFile {
  return { ...file, enabled: { ...file.enabled, [id]: config }, disabled: file.disabled.filter((d) => d !== id) };
}
