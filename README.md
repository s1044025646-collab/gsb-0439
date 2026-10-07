# SQL 子集字段血缘与别名来源解析后端

离线、纯静态的 SQL 字段值来源（field-level lineage）分析服务。输入基础表列清单与一条受限
`SELECT`，输出每个结果字段最终依赖哪些基础表列，并展示穿过表别名与 CTE 的来源路径。
只做静态分析：不连接数据库、不执行查询、不判断数据值。

技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`）+ SQLite（项目内数据目录）。
SQL 语法解析使用 `node-sql-parser` 生成 AST；**名称绑定与血缘传播为自行实现**。

## 快速开始

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 运行全部测试（tsx + node:test）
npm start          # 启动 API（默认自动选择空闲端口，PORT=8080 可指定）
npm run demo       # 用 examples/demo.sql 跑一次 CLI 分析
```

Windows 本地运行，无需 Docker / WSL / 外部服务。数据保存在项目内 `data/` 目录
（可用环境变量 `LINEAGE_DATA_DIR` 或 CLI 的 `--data-dir` 覆盖）。

## 支持范围

- 单条 `SELECT`；表别名、列别名（表达式必须显式 `AS`）
- `INNER JOIN` / `LEFT JOIN` 的 `ON` 条件、`WHERE`
- 算术表达式、标量函数调用（如 `upper(x)`、`abs(x)`）
- 非递归 `WITH`，CTE 只能引用**先声明**的 CTE（按声明顺序解析）
- `*` 与 `alias.*`：按 FROM 来源顺序、列登记顺序展开；CTE 的星号使用其已解析输出结构
- 标识符：不带引号的 ASCII，统一按小写归一化（大小写不敏感）

明确拒绝（报错，绝不输出空血缘假装成功）：聚合 / `GROUP BY` / `HAVING`、窗口函数、
`UNION` 等集合运算、相关或无关子查询、FROM 子查询、递归 CTE、`DISTINCT`、`LIMIT`、`CASE`、`CAST`。

## 核心概念：值来源 vs 条件依赖

- **字段值来源**：该输出字段的*值*由哪些基础列计算而来。算术/函数结果的来源是各参数
  来源的并集；常量列来源为空；重复引用同一列只计一次。
- **条件依赖**：`JOIN ... ON` 与 `WHERE` 使用的基础列单独列出（`conditions.join` /
  `conditions.where`），不混入任何输出字段的值来源。这只是"查询条件用到了哪些列"，
  不是完整的数据控制依赖，也不预测哪一行会通过筛选。

名称绑定规则：限定列（`a.x`）必须绑定到 FROM 中登记的别名；未限定列只有在当前所有
来源中唯一时才可解析，歧义时报错并列出候选表；未知表/列、CTE 前向或循环引用、
重复输出名均明确报错。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/schemas` | 登记 schema 新版本，body `{tables:{表:[列]}}` |
| GET  | `/schemas` | 列出 schema 版本 |
| POST | `/queries` | 提交 SQL，body `{schemaId, sql}` |
| POST | `/analyze` | 分析，body `{queryId}` 或 `{schemaId, sql}` |
| GET  | `/analyses` | 分析历史 |
| GET  | `/analyses/:id` | 完整报告（含输出顺序、来源路径、schema 版本） |
| GET  | `/analyses/:id/errors` | 绑定错误与诊断 |
| GET  | `/analyses/:id/edges` | 导出边列表（value / join / where） |

每次分析保存原始 SQL、schema 快照（按版本）、归一化口径、输出顺序与来源路径。
修订表结构或 SQL 会产生新版本/新分析；分析失败保存明确诊断而不是半份图，
历史成功报告在重启后仍可按当时的旧快照读取。

## CLI

```powershell
node dist/cli.js schema add --file examples/schema.json
node dist/cli.js analyze --schema 1 --file examples/demo.sql
node dist/cli.js analyze --schema 1 --sql "SELECT p.price FROM products p"
node dist/cli.js report 1     # 字段 -> 基础列表格 + 来源路径
node dist/cli.js errors 3     # 错误码、消息、近似位置、歧义候选
node dist/cli.js edges 1      # 边列表
node dist/cli.js history
```

## 错误码

`E_VALIDATION` 参数/标识符非法 · `E_PARSE` 语法解析失败 · `E_UNSUPPORTED` 不支持的语法 ·
`E_LIMIT` 超过限制 · `E_UNKNOWN_TABLE` / `E_UNKNOWN_COLUMN` / `E_AMBIGUOUS_COLUMN` ·
`E_CTE_FORWARD` / `E_CTE_CYCLE` · `E_DUP_OUTPUT` 重复输出名 · `E_MISSING_ALIAS` 表达式缺别名 ·
`E_NOT_FOUND`

## 限制

- SQL 长度 ≤ 100000 字符；CTE ≤ 50；单表列数 ≤ 1000；表 ≤ 200
- 每个输出字段最多展示 100 条来源路径，超出时 `pathsTruncated=true` 截断展示，
  但汇总来源集合 `sources` 始终完整
- 诊断中的行列位置为基于标识符首次出现位置的近似值
- 仅静态分析，不做行级过滤预测、数据清洗或查询优化
