export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  file: string;
  line?: number;
  message: string;
  hint?: string;
}

interface DiagnosticOptions {
  line?: number;
  hint?: string;
}

function make(severity: Severity, file: string, message: string, opts: DiagnosticOptions): Diagnostic {
  const d: Diagnostic = { severity, file, message };
  if (opts.line !== undefined) {
    d.line = opts.line;
  }
  if (opts.hint !== undefined) {
    d.hint = opts.hint;
  }
  return d;
}

export function error(file: string, message: string, opts: DiagnosticOptions = {}): Diagnostic {
  return make('error', file, message, opts);
}

export function warning(file: string, message: string, opts: DiagnosticOptions = {}): Diagnostic {
  return make('warning', file, message, opts);
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message),
  );
}

export function formatDiagnostic(d: Diagnostic): string {
  const location = d.line === undefined ? d.file : `${d.file}:${d.line}`;
  const head = `${location}: ${d.severity}: ${d.message}`;
  return d.hint === undefined ? head : `${head}\n  hint: ${d.hint}`;
}
