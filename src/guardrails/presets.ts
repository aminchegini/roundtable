import type { Preset } from './types';

export const PRESETS: Preset[] = [
  {
    id: 'solo',
    title: 'Solo',
    summary: 'Safety net only: dangerous shell commands, protected files, secrets.',
    guardrails: {
      'bash-safety': true,
      'protected-paths': true,
      'secrets-scan': true,
    },
  },
  {
    id: 'team',
    title: 'Team',
    summary: 'Solo + quality gates (typecheck, lint, tests) and project knowledge (AGENTS.md, ADRs, definition of done).',
    guardrails: {
      'bash-safety': true,
      'protected-paths': true,
      'secrets-scan': true,
      'typecheck-gate': true,
      'lint-gate': true,
      'tests-gate': { when: 'whenEdited' },
      'agents-md': true,
      adr: { enforce: false },
      'definition-of-done': true,
    },
  },
  {
    id: 'factory',
    title: 'Factory',
    summary: 'Team + architecture boundaries, enforced ADRs, reviewer veto, spec-first, worktree per implementer.',
    guardrails: {
      'bash-safety': true,
      'protected-paths': true,
      'secrets-scan': true,
      'typecheck-gate': true,
      'lint-gate': true,
      'tests-gate': { when: 'whenEdited' },
      'agents-md': true,
      'architecture-map': true,
      boundaries: true,
      adr: { enforce: true },
      'definition-of-done': { require: true },
      'reviewer-veto': true,
      'spec-first': true,
      'worktree-per-implementer': true,
    },
  },
];
