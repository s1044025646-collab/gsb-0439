import { Parser } from 'node-sql-parser';
import { fail } from './errors';

const parser = new Parser();

export interface RawSelect {
  with: Array<{ name: { value: string }; stmt: { ast: RawSelect }; columns: unknown }> | null;
  type: string;
  distinct: unknown;
  columns: Array<{ expr: RawExpr; as: string | null }> | string;
  from: Array<RawFrom> | null;
  where: RawExpr | null;
  groupby: unknown;
  having: unknown;
  orderby: unknown;
  limit: unknown;
  set_op?: unknown;
  _next?: unknown;
}

export interface RawFrom {
  db: string | null;
  table?: string;
  as: string | null;
  join?: string;
  on?: RawExpr;
  using?: unknown;
  expr?: RawExpr;
}

export interface RawExpr {
  type: string;
  operator?: string;
  left?: RawExpr;
  right?: RawExpr;
  table?: string | null;
  column?: string | { value: string };
  value?: unknown;
  name?: unknown;
  args?: { type: string; value?: RawExpr[]; expr?: RawExpr } | null;
  over?: unknown;
  expr?: RawExpr;
}

const UNSUPPORTED_MSG: Array<[keyof RawSelect, string]> = [
  ['groupby', '不支持 GROUP BY / 聚合查询'],
  ['having', '不支持 HAVING'],
  ['orderby', '不支持 ORDER BY'],
  ['limit', '不支持 LIMIT'],
];

export function parseSelect(sql: string): RawSelect {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: 'MySQL' });
  } catch (e) {
    fail('E_PARSE', `SQL 解析失败: ${(e as Error).message.split('\n')[0]}`, sql);
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) fail('E_UNSUPPORTED', '只支持单条 SELECT 语句', sql);
    ast = ast[0];
  }
  const sel = ast as RawSelect;
  if (sel.type !== 'select') fail('E_UNSUPPORTED', `只支持 SELECT 语句，收到: ${sel.type}`, sql);
  validateSelect(sel, sql);
  return sel;
}

function validateSelect(sel: RawSelect, sql: string): void {
  if (sel.set_op || sel._next) fail('E_UNSUPPORTED', '不支持 UNION / INTERSECT / EXCEPT', sql);
  if (sel.distinct) fail('E_UNSUPPORTED', '不支持 DISTINCT', sql);
  for (const [key, msg] of UNSUPPORTED_MSG) {
    const v = sel[key];
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      fail('E_UNSUPPORTED', msg, sql);
    }
  }
  if (sel.columns === '*' || !Array.isArray(sel.columns)) {
    // node-sql-parser 用字符串 '*' 表示无列场景，正常应为数组
    if (sel.columns !== '*') fail('E_PARSE', 'SELECT 列列表解析异常', sql);
  }
  for (const item of sel.from ?? []) {
    if (item.expr) fail('E_UNSUPPORTED', '不支持 FROM 子查询', sql);
    if (item.using) fail('E_UNSUPPORTED', '不支持 JOIN ... USING', sql);
    if (item.join) {
      const j = item.join.toUpperCase();
      if (j !== 'INNER JOIN' && j !== 'LEFT JOIN' && j !== 'JOIN') {
        fail('E_UNSUPPORTED', `不支持的连接类型: ${item.join}（仅支持 INNER/LEFT JOIN）`, sql, item.join);
      }
      if (!item.on) fail('E_UNSUPPORTED', 'JOIN 必须带 ON 条件', sql, item.join);
    }
  }
  for (const c of (sel.columns as Array<{ expr: RawExpr }>) ?? []) {
    validateExpr(c.expr, sql);
  }
  for (const item of sel.from ?? []) {
    if (item.on) validateExpr(item.on, sql);
  }
  if (sel.where) validateExpr(sel.where, sql);
  for (const w of sel.with ?? []) {
    validateSelect(w.stmt.ast, sql);
  }
}

const AGGR = new Set(['count', 'sum', 'avg', 'min', 'max', 'group_concat', 'std', 'stddev', 'variance']);

function validateExpr(e: RawExpr, sql: string): void {
  switch (e.type) {
    case 'column_ref':
    case 'number':
    case 'string':
    case 'single_quote_string':
    case 'double_quote_string':
    case 'bool':
    case 'null':
      return;
    case 'star':
      return;
    case 'binary_expr':
      validateExpr(e.left!, sql);
      validateExpr(e.right!, sql);
      return;
    case 'unary_expr':
      validateExpr(e.expr!, sql);
      return;
    case 'aggr_func':
      fail('E_UNSUPPORTED', '不支持聚合函数', sql, String(e.name));
    case 'window_func':
      fail('E_UNSUPPORTED', '不支持窗口函数', sql);
    case 'function': {
      const n = funcName(e);
      if (AGGR.has(n)) fail('E_UNSUPPORTED', `不支持聚合函数 ${n}`, sql, n);
      if (e.over) fail('E_UNSUPPORTED', '不支持窗口函数 (OVER)', sql, n);
      for (const a of e.args?.value ?? []) validateExpr(a, sql);
      return;
    }
    case 'select':
      fail('E_UNSUPPORTED', '不支持子查询（含相关子查询）', sql);
    case 'case':
      fail('E_UNSUPPORTED', '不支持 CASE 表达式', sql);
    case 'cast':
      fail('E_UNSUPPORTED', '不支持 CAST 表达式', sql);
    case 'exists':
      fail('E_UNSUPPORTED', '不支持 EXISTS 子查询', sql);
    default:
      fail('E_UNSUPPORTED', `不支持的表达式类型: ${e.type}`, sql);
  }
}

export function funcName(e: RawExpr): string {
  const n = e.name as { name?: Array<{ value: string }> } | string;
  if (typeof n === 'string') return n.toLowerCase();
  return (n?.name?.[0]?.value ?? '').toLowerCase();
}

