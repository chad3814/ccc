import { parseDocument } from 'yaml';
import { error, warning, type Diagnostic } from './diagnostics.js';
import type { ConceptId } from './ids.js';
import { KINDS, frontmatterSchema, sectionRule, type Frontmatter } from './schema.js';

export interface Section {
  heading: string;
  line: number;
  lines: readonly string[];
  body: string;
}

export interface Concept {
  id: ConceptId;
  file: string;
  frontmatter: Frontmatter;
  sections: ReadonlyMap<string, Section>;
  examples: readonly string[];
}

export interface ParseResult {
  concept: Concept | null;
  diagnostics: Diagnostic[];
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^## (.+?)\s*$/;
const BULLET = /^[-*] (.*)$/;
const CONTINUATION = /^\s{2,}\S/;

export function parseConcept(id: ConceptId, file: string, text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') {
    return { concept: null, diagnostics: [error(file, "missing frontmatter: file must start with a '---' line", { line: 1 })] };
  }
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    return { concept: null, diagnostics: [error(file, "unterminated frontmatter: no closing '---' line", { line: 1 })] };
  }
  const fm = parseFrontmatter(file, lines.slice(1, close).join('\n'));
  if (!fm.ok) {
    return { concept: null, diagnostics: fm.diagnostics };
  }
  const diagnostics: Diagnostic[] = [];
  const sections = splitSections(file, lines, close + 1, diagnostics);
  checkSections(file, fm.value, sections, diagnostics);
  const examplesSection = sections.get('Examples');
  const examples = examplesSection === undefined ? [] : parseExamples(file, examplesSection, diagnostics);
  if (examplesSection !== undefined && examples.length === 0 && examplesSection.body === '') {
    diagnostics.push(warning(file, "'## Examples' has no examples; ccc build requires at least one", { line: examplesSection.line }));
  }
  return { concept: { id, file, frontmatter: fm.value, sections, examples }, diagnostics };
}

type FrontmatterResult = { ok: true; value: Frontmatter } | { ok: false; diagnostics: Diagnostic[] };

function parseFrontmatter(file: string, source: string): FrontmatterResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      diagnostics: doc.errors.map((e) =>
        error(file, `frontmatter: ${e.message.split('\n')[0] ?? e.message}`, { line: (e.linePos?.[0].line ?? 0) + 1 }),
      ),
    };
  }
  const data = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, diagnostics: [error(file, 'frontmatter must be a YAML mapping of fields', { line: 1 })] };
  }
  if (!(KINDS as readonly string[]).includes(data.kind)) {
    return { ok: false, diagnostics: [error(file, `frontmatter kind: must be one of ${KINDS.join(', ')}`, { line: 1 })] };
  }
  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? ` ${issue.path.map(String).join('.')}` : '';
        return error(file, `frontmatter${where}: ${issue.message}`, { line: 1 });
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

interface OpenSection {
  heading: string;
  line: number;
  lines: string[];
}

function splitSections(file: string, lines: readonly string[], start: number, diagnostics: Diagnostic[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: OpenSection | null = null;
  let fence: string | null = null;
  let reportedStray = false;
  const flush = (): void => {
    if (current !== null && !sections.has(current.heading)) {
      sections.set(current.heading, {
        heading: current.heading,
        line: current.line,
        lines: current.lines,
        body: current.lines.join('\n').trim(),
      });
    }
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === null) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
    }
    const heading = fence === null && fenceMatch === null ? HEADING.exec(line) : null;
    if (heading !== null) {
      flush();
      const name = heading[1] ?? '';
      if (sections.has(name)) {
        diagnostics.push(error(file, `duplicate section '## ${name}'`, { line: lineNo }));
      }
      current = { heading: name, line: lineNo, lines: [] };
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
    } else if (line.trim() !== '' && !reportedStray) {
      reportedStray = true;
      diagnostics.push(
        error(file, 'text before the first ## section is not part of any section', {
          line: lineNo,
          hint: 'move it under ## Intent or delete it',
        }),
      );
    }
  }
  flush();
  if (fence !== null) {
    diagnostics.push(error(file, `unclosed code fence ${fence}`));
  }
  return sections;
}

function checkSections(file: string, fm: Frontmatter, sections: ReadonlyMap<string, Section>, diagnostics: Diagnostic[]): void {
  const rule = sectionRule(fm.kind);
  for (const section of sections.values()) {
    if (!rule.allowed.includes(section.heading)) {
      diagnostics.push(
        error(file, `unknown section '## ${section.heading}'`, {
          line: section.line,
          hint: `allowed sections for kind '${fm.kind}': ${rule.allowed.join(', ')}`,
        }),
      );
    }
  }
  for (const name of rule.required) {
    const section = sections.get(name);
    if (section === undefined) {
      diagnostics.push(error(file, `missing required section '## ${name}'`, { line: 1 }));
    } else if (section.body === '') {
      diagnostics.push(error(file, `section '## ${name}' is empty`, { line: section.line }));
    }
  }
  for (const name of rule.recommended) {
    if (!sections.has(name)) {
      diagnostics.push(warning(file, `missing '## ${name}' section; ccc build requires it`, { line: 1 }));
    }
  }
}

function parseExamples(file: string, section: Section, diagnostics: Diagnostic[]): string[] {
  const examples: string[] = [];
  section.lines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      examples.push((bullet[1] ?? '').trim());
      return;
    }
    if (CONTINUATION.test(line) && examples.length > 0) {
      const last = examples.pop();
      examples.push(`${last} ${line.trim()}`);
      return;
    }
    diagnostics.push(
      error(file, 'Examples must be a bulleted list (one "- " bullet per example)', { line: section.line + 1 + index }),
    );
  });
  return examples;
}
