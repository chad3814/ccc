import { z } from 'zod';
import { ACTION_PATTERN, ID_PATTERN } from './ids.js';

export const DOMAIN_KINDS = ['value', 'entity', 'collection', 'aggregate'] as const;
export const ADAPTER_KINDS = ['store', 'endpoint', 'auth'] as const;
export const KINDS = [...DOMAIN_KINDS, ...ADAPTER_KINDS, 'sync'] as const;
export type Kind = (typeof KINDS)[number];

const conceptRef = z.string().regex(ID_PATTERN, 'must be a concept id like game.player.hand');
const actionRef = z.string().regex(ACTION_PATTERN, 'must be an action like game.players#join');

const common = {
  interface: z.string().trim().min(1, 'interface must declare at least one export'),
  uses: z.array(conceptRef).default([]),
  implementation: z.enum(['generated', 'handwritten']).default('generated'),
  source: z.string().min(1).optional(),
};

export const frontmatterSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('value'), ...common }),
    z.strictObject({ kind: z.literal('entity'), ...common }),
    z.strictObject({ kind: z.literal('collection'), of: conceptRef, ...common }),
    z.strictObject({ kind: z.literal('aggregate'), ...common }),
    z.strictObject({ kind: z.literal('store'), persists: conceptRef, ...common }),
    z.strictObject({ kind: z.literal('endpoint'), ...common }),
    z.strictObject({ kind: z.literal('auth'), ...common }),
    z.strictObject({ kind: z.literal('sync'), when: actionRef, then: z.array(actionRef).min(1) }),
  ])
  .superRefine((fm, ctx) => {
    if (fm.kind === 'sync') {
      return;
    }
    if (fm.implementation === 'handwritten' && fm.source === undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'required when implementation is handwritten' });
    }
    if (fm.implementation === 'generated' && fm.source !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'only allowed when implementation is handwritten' });
    }
  });

export type Frontmatter = z.output<typeof frontmatterSchema>;

export function isDomainKind(kind: Kind): boolean {
  return (DOMAIN_KINDS as readonly string[]).includes(kind);
}

export function isAdapterKind(kind: Kind): boolean {
  return (ADAPTER_KINDS as readonly string[]).includes(kind);
}

export interface SectionRule {
  required: readonly string[];
  recommended: readonly string[];
  allowed: readonly string[];
}

const BASE_SECTIONS = ['Intent', 'Rules', 'Examples', 'Decisions'] as const;

export function sectionRule(kind: Kind): SectionRule {
  if (kind === 'store') {
    return { required: ['Intent', 'Schema'], recommended: ['Examples'], allowed: [...BASE_SECTIONS, 'Schema'] };
  }
  return { required: ['Intent'], recommended: ['Examples'], allowed: BASE_SECTIONS };
}

export function usesOf(fm: Frontmatter): readonly string[] {
  return fm.kind === 'sync' ? [] : fm.uses;
}

export function isHandwritten(fm: Frontmatter): boolean {
  return fm.kind !== 'sync' && fm.implementation === 'handwritten';
}
