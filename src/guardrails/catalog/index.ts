import type { GuardrailDef } from '../types';
import { bashSafety, lintGate, protectedPaths, secretsScan, testsGate, typecheckGate } from './gates';
import { adr, agentsMd, architectureMapDef, boundaries, definitionOfDone } from './knowledge';
import { reviewerVeto, specFirst, worktreePerImplementer } from './process';

/** Display order: gates, knowledge, process. */
export const CATALOG: GuardrailDef[] = [
  bashSafety,
  protectedPaths,
  secretsScan,
  typecheckGate,
  lintGate,
  testsGate,
  boundaries,
  agentsMd,
  architectureMapDef,
  adr,
  definitionOfDone,
  reviewerVeto,
  specFirst,
  worktreePerImplementer,
];

export function findGuardrail(id: string): GuardrailDef | undefined {
  return CATALOG.find((g) => g.id === id);
}
