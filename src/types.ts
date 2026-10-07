export interface BaseColumn {
  table: string;
  column: string;
}

export interface SourcePath {
  target: BaseColumn;
  steps: string[];
}

export interface OutputField {
  name: string;
  order: number;
  sources: BaseColumn[];
  paths: SourcePath[];
  pathsTruncated: boolean;
}

export interface ConditionDeps {
  join: BaseColumn[];
  where: BaseColumn[];
}

export interface Report {
  status: "ok" | "failed";
  normalization: string;
  limits: Record<string, number>;
  outputs: OutputField[];
  conditions: ConditionDeps;
  diagnostics: import("./errors").Diagnostic[];
}

export interface SchemaDef {
  tables: Record<string, string[]>;
}

export const LIMITS = {
  maxSqlLength: 100_000,
  maxCtes: 50,
  maxColumnsPerTable: 1000,
  maxTables: 200,
  maxPathsPerOutput: 100,
};
