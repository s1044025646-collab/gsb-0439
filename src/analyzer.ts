import { parseSelect, RawExpr, RawSelect, funcName } from './parser';
import {
  DEFAULT_LIMITS,
  Limits,
  norm,
  OutputField,
  Report,
  ResolvedColumn,
  SchemaDef,
  Source,
  ConditionDep,
} from './model';
import { AnalysisError, Diagnostic, fail } from './errors';

interface ExprResult {
  sources: Set<string>;
  paths: string[];
  pathsTruncated: boolean;
}

class Analyzer {
  private baseSources = new Map<string, Source>(); // 基础表名 -> Source 模板

  constructor(
    private schema: SchemaDef,
    private sql: string,
    private limits: Limits,
  ) {
    const tables = Object.keys(schema);
    if (tables.length > limits.maxTables) {
      fail('E_LIMIT', `表数量 ${tables.length} 超过限制 ${limits.maxTables}`);
    }
    for (const t of tables) {
      const cols = schema[t];
      if (cols.length > limits.maxColumnsPerTable) {
        fail('E_LIMIT', `表 ${t} 列数 ${cols.length} 超过限制 ${limits.maxColumnsPerTable}`);
      }
      const nt = norm(t);
      this.baseSources.set(nt, {
        alias: nt,
        kind: 'table',
        table: nt,
        columns: cols.map((c) => {
          const nc = norm(c);
          return { name: nc, sources: [`${nt}.${nc}`], paths: [`${nt}.${nc}`], pathsTruncated: false };
        }),
      });
    }
  }

  run(): { outputs: OutputField[]; conditions: ConditionDep[] } {
    const sel = parseSelect(this.sql);
    const ctes = new Map<string, Source>();
    return this.analyzeSelect(sel, ctes);
  }

  private analyzeSelect(
    sel: RawSelect,
    outerCtes: Map<string, Source>,
  ): { outputs: OutputField[]; conditions: ConditionDep[] } {
    const ctes = new Map(outerCtes);
    const withList = sel.with ?? [];
    if (withList.length > this.limits.maxCtes) {
      fail('E_LIMIT', `CTE 数量 ${withList.length} 超过限制 ${this.limits.maxCtes}`, this.sql);
    }
    const pending = new Set(withList.map((w) => norm(w.name.value)));
    for (const w of withList) {
      const name = norm(w.name.value);
      pending.delete(name);
      // 前向/循环引用检测：CTE 体内引用了尚未定义的 CTE 名
      const body = w.stmt.ast;
      const referenced = collectFromNames(body);
      for (const r of referenced) {
        if (r === name) {
          fail('E_CTE_CYCLE', `CTE "${name}" 引用了自身（不支持递归 CTE）`, this.sql, name);
        }
        if (pending.has(r)) {
          fail('E_CTE_FORWARD', `CTE "${name}" 前向引用了尚未声明的 CTE "${r}"`, this.sql, r);
        }
      }
      const sub = this.analyzeSelect(body, ctes);
      ctes.set(name, {
        alias: name,
        kind: 'cte',
        columns: sub.outputs.map((o) => ({
          name: o.name,
          sources: o.sources,
          paths: o.paths,
          pathsTruncated: o.pathsTruncated,
        })),
      });
    }

    // 构建 FROM 作用域（按声明顺序）
    const scope: Source[] = [];
    const conditions: ConditionDep[] = [];
    const fromItems = sel.from ?? [];
    if (fromItems.length === 0) fail('E_UNSUPPORTED', 'SELECT 必须包含 FROM', this.sql);
    for (const item of fromItems) {
      const tableName = norm(item.table ?? '');
      const alias = norm(item.as ?? item.table ?? '');
      let src: Source;
      const base = this.baseSources.get(tableName);
      if (base) {
        src = {
          alias,
          kind: 'table',
          table: tableName,
          columns: base.columns.map((c) => ({
            name: c.name,
            sources: c.sources,
            paths: c.paths.map((p) => `${alias}.${c.name} -> ${p}`),
            pathsTruncated: false,
          })),
        };
      } else {
        const cte = ctes.get(tableName);
        if (!cte) {
          fail('E_UNKNOWN_TABLE', `未知表或 CTE: "${tableName}"`, this.sql, item.table ?? '');
        }
        src = {
          alias,
          kind: 'cte',
          columns: cte.columns.map((c) => ({
            name: c.name,
            sources: c.sources,
            paths: c.paths.map((p) => `${alias}.${c.name} -> ${p}`),
            pathsTruncated: c.pathsTruncated,
          })),
        };
      }
      scope.push(src);
      if (item.on) {
        const r = this.resolveExpr(item.on, scope);
        conditions.push({ clause: 'join_on', columns: [...r.sources].sort() });
      }
    }
    if (sel.where) {
      const r = this.resolveExpr(sel.where, scope);
      conditions.push({ clause: 'where', columns: [...r.sources].sort() });
    }

    // 展开输出列
    const outputs: OutputField[] = [];
    const seen = new Set<string>();
    const pushOutput = (name: string, r: ExprResult) => {
      const n = norm(name);
      if (seen.has(n)) fail('E_DUP_OUTPUT', `重复的输出字段名: "${n}"`, this.sql, n);
      seen.add(n);
      outputs.push({
        name: n,
        sources: [...r.sources].sort(),
        paths: r.paths.slice(0, this.limits.maxPathsPerField),
        pathsTruncated: r.pathsTruncated || r.paths.length > this.limits.maxPathsPerField,
      });
    };

    for (const col of sel.columns as Array<{ expr: RawExpr; as: string | null }>) {
      const e = col.expr;
      if (e.type === 'star' || (e.type === 'column_ref' && e.column === '*')) {
        const qualifier = e.type === 'column_ref' && e.table ? norm(e.table) : null;
        const targets = qualifier ? scope.filter((s) => s.alias === qualifier) : scope;
        if (qualifier && targets.length === 0) {
          fail('E_UNKNOWN_TABLE', `星号限定了未知别名: "${qualifier}"`, this.sql, qualifier);
        }
        for (const s of targets) {
          for (const c of s.columns) {
            pushOutput(c.name, {
              sources: new Set(c.sources),
              paths: c.paths,
              pathsTruncated: c.pathsTruncated,
            });
          }
        }
        continue;
      }
      const r = this.resolveExpr(e, scope);
      let name: string;
      if (col.as) {
        name = col.as;
      } else if (e.type === 'column_ref') {
        name = String(e.column);
      } else {
        fail('E_EXPR_NEEDS_ALIAS', '计算表达式/函数/常量输出必须显式指定别名 (AS ...)', this.sql);
      }
      // 为输出名追加路径首跳，便于解释
      const paths = r.paths.map((p) => `${norm(name)} -> ${p}`);
      pushOutput(name, { sources: r.sources, paths, pathsTruncated: r.pathsTruncated });
    }
    return { outputs, conditions };
  }

  private resolveExpr(e: RawExpr, scope: Source[]): ExprResult {
    switch (e.type) {
      case 'column_ref':
        return this.resolveColumn(e, scope);
      case 'number':
      case 'string':
      case 'single_quote_string':
      case 'double_quote_string':
      case 'bool':
      case 'null':
        return { sources: new Set(), paths: [], pathsTruncated: false };
      case 'unary_expr':
        return this.resolveExpr(e.expr!, scope);
      case 'binary_expr': {
        const l = this.resolveExpr(e.left!, scope);
        const r = this.resolveExpr(e.right!, scope);
        return mergeResults([l, r], this.limits.maxPathsPerField);
      }
      case 'function': {
        const args = (e.args?.value ?? []).map((a) => this.resolveExpr(a, scope));
        if (args.length === 0) return { sources: new Set(), paths: [], pathsTruncated: false };
        return mergeResults(args, this.limits.maxPathsPerField);
      }
      default:
        fail('E_UNSUPPORTED', `不支持的表达式类型: ${e.type}`, this.sql);
    }
  }

  private resolveColumn(e: RawExpr, scope: Source[]): ExprResult {
    const colName = norm(String(e.column));
    if (e.table) {
      const alias = norm(e.table);
      const src = scope.find((s) => s.alias === alias);
      if (!src) fail('E_UNKNOWN_TABLE', `限定了未知表别名: "${alias}"`, this.sql, alias);
      const col = src.columns.find((c) => c.name === colName);
      if (!col) {
        fail('E_UNKNOWN_COLUMN', `别名 "${alias}" 下不存在列 "${colName}"`, this.sql, colName);
      }
      return { sources: new Set(col.sources), paths: col.paths, pathsTruncated: col.pathsTruncated };
    }
    const matches: Array<{ src: Source; col: ResolvedColumn }> = [];
    for (const s of scope) {
      const col = s.columns.find((c) => c.name === colName);
      if (col) matches.push({ src: s, col });
    }
    if (matches.length === 0) {
      fail('E_UNKNOWN_COLUMN', `未知列: "${colName}"`, this.sql, colName);
    }
    if (matches.length > 1) {
      const candidates = matches.map((m) => `${m.src.alias}.${colName}`).join(', ');
      fail('E_AMBIGUOUS_COLUMN', `列 "${colName}" 存在歧义，候选: ${candidates}`, this.sql, colName);
    }
    const { col } = matches[0];
    return { sources: new Set(col.sources), paths: col.paths, pathsTruncated: col.pathsTruncated };
  }
}

function mergeResults(results: ExprResult[], maxPaths: number): ExprResult {
  const sources = new Set<string>();
  const pathSet = new Set<string>();
  let truncated = false;
  for (const r of results) {
    for (const s of r.sources) sources.add(s);
    for (const p of r.paths) {
      if (pathSet.size >= maxPaths) {
        truncated = true;
        break;
      }
      pathSet.add(p);
    }
    if (r.pathsTruncated) truncated = true;
  }
  return { sources, paths: [...pathSet], pathsTruncated: truncated };
}

function collectFromNames(sel: RawSelect): Set<string> {
  const names = new Set<string>();
  const walk = (s: RawSelect) => {
    for (const item of s.from ?? []) {
      if (item.table) names.add(norm(item.table));
    }
    for (const w of s.with ?? []) walk(w.stmt.ast);
  };
  walk(sel);
  return names;
}

export function analyze(
  sql: string,
  schema: SchemaDef,
  limits: Limits = DEFAULT_LIMITS,
): Report {
  try {
    if (sql.length > limits.maxSqlLength) {
      fail('E_LIMIT', `SQL 长度 ${sql.length} 超过限制 ${limits.maxSqlLength}`);
    }
    const analyzer = new Analyzer(schema, sql, limits);
    const { outputs, conditions } = analyzer.run();
    return { ok: true, outputs, conditions, errors: [] };
  } catch (e) {
    if (e instanceof AnalysisError) {
      return { ok: false, outputs: [], conditions: [], errors: [e.diag] };
    }
    const diag: Diagnostic = { code: 'E_PARSE', message: `内部错误: ${(e as Error).message}`, position: -1 };
    return { ok: false, outputs: [], conditions: [], errors: [diag] };
  }
}

