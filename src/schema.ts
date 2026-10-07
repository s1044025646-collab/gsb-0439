import { SchemaDef, LIMITS } from "./types";
import { fail } from "./errors";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 归一化规则：不带引号 ASCII 标识符统一转小写。 */
export function norm(name: string): string {
  return name.toLowerCase();
}

export function validateIdent(name: unknown, what: string): string {
  if (typeof name !== "string" || !IDENT.test(name)) {
    fail({ code: "E_VALIDATION", message: `${what} "${String(name)}" 不是合法的不带引号 ASCII 标识符` });
  }
  return norm(name as string);
}

export function validateSchema(def: unknown): SchemaDef {
  if (typeof def !== "object" || def === null || typeof (def as any).tables !== "object" || (def as any).tables === null) {
    fail({ code: "E_VALIDATION", message: "schema 需要形如 { tables: { 表名: [列...] } }" });
  }
  const tables: Record<string, string[]> = {};
  const entries = Object.entries((def as SchemaDef).tables);
  if (entries.length === 0) fail({ code: "E_VALIDATION", message: "schema 至少包含一张表" });
  if (entries.length > LIMITS.maxTables)
    fail({ code: "E_LIMIT", message: `表数量超过上限 ${LIMITS.maxTables}` });
  for (const [rawName, cols] of entries) {
    const name = validateIdent(rawName, "表名");
    if (tables[name]) fail({ code: "E_VALIDATION", message: `重复的表名 ${name}（归一化后冲突）` });
    if (!Array.isArray(cols) || cols.length === 0)
      fail({ code: "E_VALIDATION", message: `表 ${name} 需要非空列数组` });
    if (cols.length > LIMITS.maxColumnsPerTable)
      fail({ code: "E_LIMIT", message: `表 ${name} 列数超过上限 ${LIMITS.maxColumnsPerTable}` });
    const seen = new Set<string>();
    tables[name] = cols.map((c) => {
      const col = validateIdent(c, `表 ${name} 的列名`);
      if (seen.has(col)) fail({ code: "E_VALIDATION", message: `表 ${name} 存在重复列 ${col}` });
      seen.add(col);
      return col;
    });
  }
  return { tables };
}
