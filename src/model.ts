/** 归一化规则：不带引号的 ASCII 标识符统一转小写 */
export function norm(name: string): string {
  return name.toLowerCase();
}

/** 基础表结构：表名 -> 按登记顺序排列的列名 */
export type SchemaDef = Record<string, string[]>;

export interface Limits {
  maxSqlLength: number;
  maxCtes: number;
  maxColumnsPerTable: number;
  maxTables: number;
  maxPathsPerField: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSqlLength: 20000,
  maxCtes: 16,
  maxColumnsPerTable: 500,
  maxTables: 100,
  maxPathsPerField: 100,
};

/** 某一列（在某一作用域中）已解析的值来源 */
export interface ResolvedColumn {
  name: string;
  /** 基础列集合，格式 "table.column"，已去重 */
  sources: string[];
  /** 来源路径，如 "s2.amt -> amt -> o.qty -> orders.qty"，已去重 */
  paths: string[];
  pathsTruncated: boolean;
}

export interface Source {
  /** 在当前作用域中的可见名（表别名或 CTE 名） */
  alias: string;
  kind: 'table' | 'cte';
  /** kind=table 时的基础表名 */
  table?: string;
  columns: ResolvedColumn[];
}

export interface OutputField {
  name: string;
  sources: string[];
  paths: string[];
  pathsTruncated: boolean;
}

export interface ConditionDep {
  clause: 'join_on' | 'where';
  /** 该条件使用到的基础列，已去重 */
  columns: string[];
}

export interface Report {
  ok: boolean;
  outputs: OutputField[];
  conditions: ConditionDep[];
  errors: import('./errors').Diagnostic[];
}
