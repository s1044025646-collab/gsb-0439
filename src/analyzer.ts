import { Parser } from "node-sql-parser";
import { SchemaDef, BaseColumn, SourcePath, OutputField, Report, LIMITS } from "./types";
import { norm, validateIdent } from "./schema";
import { AnalysisError, Diagnostic, fail, locate } from "./errors";

interface Target {
  base: BaseColumn;
  chain: string[]; // 从当前作用域列到基础列的跳转路径
}

interface ColInfo {
  name: string;
  targets: Target[];
}

interface Source {
  alias: string;
  label: string; // 用于路径展示
  columns: ColInfo[];
}

interface CteOut {
  name: string;
  columns: ColInfo[];
  conditions: { join: BaseColumn[]; where: BaseColumn[] };
}

const parser = new Parser();

function dedupBase(list: BaseColumn[]): BaseColumn[] {
  const seen = new Set<string>();
  const out: BaseColumn[] = [];
  for (const b of list) {
    const k = b.table + "." + b.column;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(b);
    }
  }
  return out;
}

function dedupPaths(list: SourcePath[]): SourcePath[] {
  const seen = new Set<string>();
  const out: SourcePath[] = [];
  for (const p of list) {
    const k = p.target.table + "." + p.target.column + "|" + p.steps.join(">");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

class Analyzer {
  private ctes = new Map<string, CteOut>();
  private cteNames: string[] = [];
  private analyzingCte: string | null = null;

  constructor(private sql: string, private schema: SchemaDef) {}

  run(): Report {
    const ast = this.parse();
    const outputs = this.analyzeSelect(ast);
    return {
      status: "ok",
      normalization: "identifiers: unquoted ASCII, case-insensitive, stored lowercase",
      limits: { ...LIMITS },
      outputs: outputs.fields,
      conditions: outputs.conditions,
      diagnostics: [],
    };
  }

  private parse(): any {
    if (/\brecursive\b/i.test(this.sql))
      fail({ code: "E_UNSUPPORTED", message: "不支持递归 CTE（WITH RECURSIVE）" });
    let ast: any;
    try {
      ast = parser.astify(this.sql, { database: "MySQL" });
    } catch (e: any) {
      fail({ code: "E_PARSE", message: "SQL 解析失败: " + String(e.message || e).split("\n")[0] });
    }
    if (Array.isArray(ast))
      fail({ code: "E_VALIDATION", message: "只接受单条 SELECT 语句" });
    if (ast.type !== "select")
      fail({ code: "E_UNSUPPORTED", message: `仅支持 SELECT，收到 ${ast.type}` });
    if ((ast as any)._next)
      fail({ code: "E_UNSUPPORTED", message: "不支持 UNION / INTERSECT / EXCEPT" });
    return ast;
  }

  private checkSelectShape(node: any): void {
    if (node.groupby || node.having)
      fail({ code: "E_UNSUPPORTED", message: "不支持 GROUP BY / HAVING（聚合）" });
    if (node.distinct)
      fail({ code: "E_UNSUPPORTED", message: "不支持 DISTINCT" });
    if (node.limit)
      fail({ code: "E_UNSUPPORTED", message: "不支持 LIMIT" });
    if (node.window)
      fail({ code: "E_UNSUPPORTED", message: "不支持窗口函数" });
  }

  private analyzeSelect(node: any): { fields: OutputField[]; conditions: { join: BaseColumn[]; where: BaseColumn[] } } {
    this.checkSelectShape(node);
    // 1. 处理 WITH（按声明顺序）
    if (node.with) {
      if (node.with.length > LIMITS.maxCtes)
        fail({ code: "E_LIMIT", message: `CTE 数量超过上限 ${LIMITS.maxCtes}` });
      const declared = node.with.map((c: any) => validateIdent(c.name.value, "CTE 名"));
      for (const n of declared)
        if (this.ctes.has(n) || this.cteNames.includes(n))
          fail({ code: "E_VALIDATION", message: `CTE ${n} 重复定义` });
      this.cteNames.push(...declared);
      for (const cte of node.with) {
        const name = norm(cte.name.value);
        const prev = this.analyzingCte;
        this.analyzingCte = name;
        const inner = this.analyzeSelect(cte.stmt.ast);
        this.analyzingCte = prev;
        this.ctes.set(name, {
          name,
          columns: inner.fields.map((f) => ({
            name: f.name,
            targets: f.paths.map((p) => ({ base: p.target, chain: [`cte ${name}.${f.name}`, ...p.steps] })),
          })),
          conditions: inner.conditions,
        });
      }
    }
    // 2. 构建 FROM 作用域
    const sources: Source[] = [];
    const joinDeps: BaseColumn[] = [];
    const cteJoinDeps: BaseColumn[] = [];
    const cteWhereDeps: BaseColumn[] = [];
    if (!node.from || node.from.length === 0)
      fail({ code: "E_VALIDATION", message: "FROM 子句不能为空" });
    for (const item of node.from) {
      if (item.expr)
        fail({ code: "E_UNSUPPORTED", message: "不支持 FROM 子查询" });
      if (item.join && !/^(INNER|LEFT) JOIN$/i.test(item.join))
        fail({ code: "E_UNSUPPORTED", message: `仅支持 INNER JOIN / LEFT JOIN，收到 ${item.join}` });
      const src = this.buildSource(item);
      if (sources.some((s) => s.alias === src.alias))
        fail({ code: "E_VALIDATION", message: `FROM 中别名 ${src.alias} 重复` });
      sources.push(src);
      const usedCte = this.ctes.get(norm(item.table));
      if (usedCte) {
        cteJoinDeps.push(...usedCte.conditions.join);
        cteWhereDeps.push(...usedCte.conditions.where);
      }
      if (item.on) joinDeps.push(...this.exprTargets(item.on, sources).bases);
    }
    // 3. WHERE 条件依赖
    const whereDeps: BaseColumn[] = node.where ? this.exprTargets(node.where, sources).bases : [];
    // 4. 输出列
    const fields: OutputField[] = [];
    const names = new Set<string>();
    let order = 0;
    for (const col of node.columns) {
      const expr = col.expr;
      if (expr.type === "column_ref" && expr.column === "*") {
        const expanded = this.expandStar(expr.table, sources);
        for (const c of expanded) {
          if (names.has(c.name))
            fail({ code: "E_DUP_OUTPUT", message: `星号展开产生重复输出名 ${c.name}`, ...locate(this.sql, c.name) });
          names.add(c.name);
          fields.push(this.makeField(c.name, order++, c.targets));
        }
        continue;
      }
      let outName: string;
      if (col.as) {
        outName = validateIdent(col.as, "列别名");
      } else if (expr.type === "column_ref") {
        outName = validateIdent(expr.column, "列名");
      } else {
        fail({ code: "E_MISSING_ALIAS", message: "表达式输出必须显式给出别名（AS）" });
      }
      if (names.has(outName))
        fail({ code: "E_DUP_OUTPUT", message: `重复的输出字段名 ${outName}`, ...locate(this.sql, outName) });
      names.add(outName);
      const t = this.exprTargets(expr, sources);
      fields.push(this.makeField(outName, order++, t.targets));
    }
    return {
      fields,
      conditions: {
        join: dedupBase([...joinDeps, ...cteJoinDeps]),
        where: dedupBase([...whereDeps, ...cteWhereDeps]),
      },
    };
  }

  private makeField(name: string, order: number, targets: Target[]): OutputField {
    const paths = dedupPaths(targets.map((t) => ({ target: t.base, steps: t.chain })));
    const truncated = paths.length > LIMITS.maxPathsPerOutput;
    return {
      name,
      order,
      sources: dedupBase(targets.map((t) => t.base)),
      paths: truncated ? paths.slice(0, LIMITS.maxPathsPerOutput) : paths,
      pathsTruncated: truncated,
    };
  }

  private buildSource(item: any): Source {
    const rawName = validateIdent(item.table, "表名");
    const alias = item.as ? validateIdent(item.as, "表别名") : rawName;
    const cte = this.ctes.get(rawName);
    if (cte) {
      return {
        alias,
        label: `cte ${rawName}`,
        columns: cte.columns.map((c) => ({
          name: c.name,
          targets: c.targets.map((t) => ({ base: t.base, chain: [...t.chain] })),
        })),
      };
    }
    if (this.cteNames.includes(rawName)) {
      // 引用了尚未定义的 CTE
      if (rawName === this.analyzingCte)
        fail({ code: "E_CTE_CYCLE", message: `CTE ${rawName} 循环引用自身`, ...locate(this.sql, rawName) });
      fail({ code: "E_CTE_FORWARD", message: `CTE ${rawName} 前向引用（只能引用先声明的 CTE）`, ...locate(this.sql, rawName) });
    }
    const cols = this.schema.tables[rawName];
    if (!cols)
      fail({ code: "E_UNKNOWN_TABLE", message: `未知基础表 ${rawName}`, ...locate(this.sql, rawName) });
    return {
      alias,
      label: `table ${rawName}`,
      columns: cols.map((c) => ({
        name: c,
        targets: [
          {
            base: { table: rawName, column: c },
            chain: alias !== rawName ? [`alias ${alias}.${c}`, `base ${rawName}.${c}`] : [`base ${rawName}.${c}`],
          },
        ],
      })),
    };
  }

  private expandStar(table: string | null, sources: Source[]): ColInfo[] {
    if (table) {
      const alias = norm(validateIdent(table, "表别名"));
      const src = sources.find((s) => s.alias === alias);
      if (!src)
        fail({ code: "E_UNKNOWN_TABLE", message: `星号引用了未知别名 ${alias}`, ...locate(this.sql, alias) });
      return src.columns;
    }
    return sources.flatMap((s) => s.columns);
  }

  private resolveColumn(table: string | null, column: string, sources: Source[]): Target[] {
    const col = validateIdent(column, "列名");
    if (table) {
      const alias = norm(validateIdent(table, "表别名"));
      const src = sources.find((s) => s.alias === alias);
      if (!src)
        fail({ code: "E_UNKNOWN_TABLE", message: `未知表别名 ${alias}（限定列必须绑定已登记的来源别名）`, ...locate(this.sql, alias) });
      const c = src.columns.find((x) => x.name === col);
      if (!c)
        fail({ code: "E_UNKNOWN_COLUMN", message: `来源 ${alias} 中不存在列 ${col}`, ...locate(this.sql, col) });
      return c.targets;
    }
    const matches = sources.filter((s) => s.columns.some((c) => c.name === col));
    if (matches.length === 0)
      fail({ code: "E_UNKNOWN_COLUMN", message: `当前作用域中不存在列 ${col}`, ...locate(this.sql, col) });
    if (matches.length > 1)
      fail({
        code: "E_AMBIGUOUS_COLUMN",
        message: `列 ${col} 存在歧义，候选来源: ${matches.map((m) => m.alias).join(", ")}`,
        candidates: matches.map((m) => m.alias),
        ...locate(this.sql, col),
      });
    return matches[0].columns.find((c) => c.name === col)!.targets;
  }

  /** 解析表达式，返回基础列集合与带路径的目标集合 */
  private exprTargets(expr: any, sources: Source[]): { bases: BaseColumn[]; targets: Target[] } {
    const targets = this.walk(expr, sources);
    return { bases: dedupBase(targets.map((t) => t.base)), targets };
  }

  private walk(expr: any, sources: Source[]): Target[] {
    if (!expr || typeof expr !== "object") return [];
    switch (expr.type) {
      case "column_ref": {
        if (expr.column === "*")
          fail({ code: "E_UNSUPPORTED", message: "星号只允许出现在 SELECT 输出列表顶层" });
        return this.resolveColumn(expr.table, expr.column, sources);
      }
      case "number":
      case "string":
      case "single_quote_string":
      case "bool":
      case "null":
      case "date":
      case "datetime":
        return []; // 常量：值来源为空
      case "binary_expr":
        return [...this.walk(expr.left, sources), ...this.walk(expr.right, sources)];
      case "unary_expr":
        return this.walk(expr.expr, sources);
      case "expr_list":
        return (expr.value || []).flatMap((v: any) => this.walk(v, sources));
      case "function": {
        if (expr.over)
          fail({ code: "E_UNSUPPORTED", message: "不支持窗口函数" });
        const fn = expr.name?.name?.[0]?.value ?? "";
        if (!expr.args) return [];
        if (expr.args.type === "expr_list")
          return (expr.args.value || []).flatMap((v: any) => this.walk(v, sources));
        return this.walk(expr.args, sources);
        void fn;
      }
      case "aggr_func":
        fail({ code: "E_UNSUPPORTED", message: `不支持聚合函数 ${expr.name || ""}` });
        break;
      case "case":
        fail({ code: "E_UNSUPPORTED", message: "不支持 CASE 表达式" });
        break;
      case "select":
        fail({ code: "E_UNSUPPORTED", message: "不支持子查询" });
        break;
      case "cast":
        fail({ code: "E_UNSUPPORTED", message: "不支持 CAST" });
        break;
      default:
        fail({ code: "E_UNSUPPORTED", message: `不支持的表达式类型: ${expr.type}` });
    }
    return [];
  }
}

export function analyze(sql: string, schema: SchemaDef): Report {
  if (typeof sql !== "string" || sql.trim().length === 0)
    fail({ code: "E_VALIDATION", message: "SQL 不能为空" });
  if (sql.length > LIMITS.maxSqlLength)
    fail({ code: "E_LIMIT", message: `SQL 长度超过上限 ${LIMITS.maxSqlLength}` });
  try {
    return new Analyzer(sql, schema).run();
  } catch (e) {
    if (e instanceof AnalysisError) {
      return {
        status: "failed",
        normalization: "identifiers: unquoted ASCII, case-insensitive, stored lowercase",
        limits: { ...LIMITS },
        outputs: [],
        conditions: { join: [], where: [] },
        diagnostics: e.diagnostics,
      };
    }
    throw e;
  }
}
