export type ErrorCode =
  | 'E_VALIDATION'
  | 'E_PARSE'
  | 'E_UNSUPPORTED'
  | 'E_LIMIT'
  | 'E_UNKNOWN_TABLE'
  | 'E_UNKNOWN_COLUMN'
  | 'E_AMBIGUOUS_COLUMN'
  | 'E_CTE_FORWARD'
  | 'E_CTE_CYCLE'
  | 'E_DUP_OUTPUT'
  | 'E_MISSING_ALIAS'
  | 'E_NOT_FOUND';

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  line?: number;
  column?: number;
  candidates?: string[];
}

export class AnalysisError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
    this.diagnostics = diagnostics;
  }
}

export function fail(d: Diagnostic): never {
  throw new AnalysisError([d]);
}

/** Best-effort position of an identifier in the SQL text (approximate). */
export function locate(sql: string, name: string): { line?: number; column?: number } {
  if (!name) return {};
  const idx = sql.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) return {};
  const head = sql.slice(0, idx);
  const line = head.split('\n').length;
  const column = idx - head.lastIndexOf('\n');
  return { line, column };
}
