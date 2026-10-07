# SQL 字段血缘与别名来源解析后端

离线、纯静态的 SQL 字段值来源分析服务。输入基础表列清单和一条受限 SELECT，
输出每个结果字段最终依赖哪些基础表列，并展示通过表别名和 CTE 的来源路径。
只做静态分析：不连接数据库、不执行查询、不判断数据值。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，无原生编译依赖）+ `node-sql-parser`（仅用于生成 AST，名称绑定与血缘传播为自行实现）。Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # products/orders 演示（含两层 CTE 重命名）
npm start         # 启动 HTTP API（默认选择空闲端口，PORT=8080 可指定）
```

数据保存在项目内 `data/` 目录（可用环境变量 `DATA_DIR` 修改）。

## CLI

```powershell
node dist/src/cli.js schema --inline '{"products":["id","price"],"orders":["product_id","qty","status"]}'
node dist/src/cli.js analyze --schema 1 --sql "SELECT p.price*o.qty AS amount FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.status<>1"
node dist/src/cli.js report 1            # 字段 -> 基础列表格 + 条件依赖
node dist/src/cli.js report 1 --field amount
node dist/src/cli.js errors 1            # 绑定错误及 SQL 位置指示
node dist/src/cli.js edges 1             # 导出边列表（value / condition）
node dist/src/cli.js history             # 历史查询
node dist/src/cli.js serve --port 8080
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/schemas` | 登记 schema 新版本，body: `{"表名":["列"...]}` |
| GET | `/schemas` `/schemas/:id` | 列出 / 读取 schema 快照 |
| POST | `/queries` | 提交 SQL 并分析，body: `{"schemaId":1,"sql":"..."}`；分析失败返回 422 及诊断 |
| GET | `/queries` `/queries/:id` | 历史 / 完整报告（含输出顺序、来源路径、分析口径） |
| GET | `/queries/:id/fields/:name` | 单个输出字段的值来源与路径 |
| GET | `/queries/:id/errors` | 绑定错误诊断 |
| GET | `/queries/:id/edges` | 边列表（`type=value` 值来源，`type=condition` 条件依赖） |

错误响应统一为 `{"code": "...", "message": "..."}`，错误码：
`E_PARSE`、`E_UNSUPPORTED`、`E_UNKNOWN_TABLE`、`E_UNKNOWN_COLUMN`、
`E_AMBIGUOUS_COLUMN`、`E_CTE_FORWARD`、`E_CTE_CYCLE`、`E_DUP_OUTPUT`、
`E_EXPR_NEEDS_ALIAS`、`E_LIMIT`、`E_VALIDATION`。

## 支持范围

支持：单条 SELECT；表别名与列别名；INNER/LEFT JOIN 的 ON 条件；WHERE；
算术表达式与标量函数调用；非递归 WITH（按声明顺序引用）；`*` 与 `别名.*`
（按来源表顺序及登记列顺序展开，CTE 的星号使用其已解析输出结构）。

明确拒绝（报错而非输出空血缘）：聚合、GROUP BY/HAVING、窗口函数、UNION、
ORDER BY/LIMIT/DISTINCT、CASE/CAST、相关或标量子查询、FROM 子查询、递归 CTE。

标识符规则：不带引号的 ASCII 标识符，统一按小写归一化（大小写不敏感）。

## 两个核心概念的区别

- **字段值来源（value lineage）**：结果字段的值由哪些基础列计算而来。
  算术/函数结果的来源是各参数来源的集合；常量列来源为空；
  重复引用同一列只计一次；路径逐层穿过别名与 CTE 供解释。
- **条件依赖（condition dependency）**：JOIN ON 与 WHERE 使用的基础列，
  单独列出，不混入任何输出字段的值来源。这只是"哪些列参与了筛选"，
  不是完整的数据控制依赖，也不预测哪一行会通过筛选。

示例：`price*qty AS amount` 的值来源只有 `products.price` 和 `orders.qty`；
连接键 `products.id`/`orders.product_id` 与 `orders.status` 只出现在条件依赖中。

## 绑定规则

- 限定列（`别名.列`）必须绑定到对应表别名，别名遮蔽原表名。
- 未限定列只有在当前所有来源中唯一时才可解析；歧义时报错并列出候选表。
- 基础表缺失、未知列、CTE 前向/循环引用、重复输出名均明确报错。
- 计算表达式、函数、常量输出必须显式 `AS` 别名。

## 持久化与版本

SQLite 保存原始 SQL、schema 快照、分析口径（限制参数）、输出顺序与来源路径。
每次登记 schema 或提交 SQL 都建立新版本；分析失败保存明确诊断而不是半份成功图；
修订 schema 后旧查询可能失效，但旧报告仍按旧快照解释，服务重启后仍可读取。

## 限制（默认值，见 `src/model.ts`）

SQL 长度 20000；CTE 数量 16；单表列数 500；表数量 100；每字段解释路径 100 条
（超出截断并打 `pathsTruncated` 标记，汇总来源集合始终完整）。

## 已知限制

- 仅 MySQL 方言子集（解析器口径）；字符串/数字常量参与表达式但不产生来源。
- 错误位置为出错标识符在 SQL 中的首次出现位置（尽力而为）。
- 路径展示为逐跳链条，多条重复路径去重；超限时截断展示。
