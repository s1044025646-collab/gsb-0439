export type ErrorCode =
  | 'E_PARSE'
  | 'E_UNSUPPORTED'
  | 'E_UNKNOWN_TABLE'
  | 'E_UNKNOWN_COLUMN'
  | 'E_AMBIGUOUS_COLUMN'
  | 'E_CTE_FORWARD'
  | 'E_CTE_CYCLE'
  | 'E_DUP_OUTPUT'
  | 'E_EXPR_NEEDS_ALIAS'
  | 'E_LIMIT'
  | 'E_VALIDATION';

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  /** 出错标识符在原始 SQL 中的偏移（尽力而为，-1 表示未知） */
  position: number;
}

export class AnalysisError extends Error {
  constructor(
    public readonly diag: Diagnostic,
  ) {
    super(diag.message);
  }
}

export function fail(code: ErrorCode, message: string, sql?: string, token?: string): never {
  let position = -1;
  if (sql && token) {
    position = sql.toLowerCase().indexOf(token.toLowerCase());
  }
  throw new AnalysisError({ code, message, position });
}
