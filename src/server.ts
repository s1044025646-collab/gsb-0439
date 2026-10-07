import * as http from 'node:http';
import * as path from 'node:path';
import { Store } from './store';
import { DEFAULT_LIMITS, SchemaDef } from './model';
import { ErrorCode } from './errors';

interface ApiError extends Error {
  statusCode?: number;
  code?: ErrorCode;
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'E_VALIDATION' as ErrorCode });
}

function validateSchemaDef(body: unknown): SchemaDef {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    bad('schema 必须是 { 表名: [列名...] } 对象');
  }
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const def: SchemaDef = {};
  for (const [t, cols] of Object.entries(body as Record<string, unknown>)) {
    if (!ident.test(t)) bad(`非法表名: "${t}"（仅支持不带引号的 ASCII 标识符）`);
    if (!Array.isArray(cols) || cols.length === 0) bad(`表 "${t}" 的列清单必须是非空数组`);
    const seen = new Set<string>();
    for (const c of cols) {
      if (typeof c !== 'string' || !ident.test(c)) bad(`表 "${t}" 含非法列名: ${JSON.stringify(c)}`);
      const n = c.toLowerCase();
      if (seen.has(n)) bad(`表 "${t}" 含重复列名: "${c}"`);
      seen.add(n);
    }
    const nt = t.toLowerCase();
    if (def[nt]) bad(`重复的表名: "${t}"`);
    def[nt] = (cols as string[]).map((c) => c.toLowerCase());
  }
  if (Object.keys(def).length === 0) bad('schema 至少要包含一张表');
  return def;
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体必须是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'POST' && parts[0] === 'schemas' && parts.length === 1) {
        const def = validateSchemaDef(await readBody(req));
        return send(201, store.addSchema(def));
      }
      if (method === 'GET' && parts[0] === 'schemas') {
        if (parts.length === 1) return send(200, store.listSchemas());
        const s = store.getSchema(Number(parts[1]));
        if (!s) return send(404, { code: 'E_VALIDATION', message: 'schema 不存在' });
        return send(200, s);
      }
      if (method === 'POST' && parts[0] === 'queries' && parts.length === 1) {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        if (!body || typeof body.sql !== 'string' || body.sql.trim() === '') bad('缺少 sql 字段');
        const schemaId = Number(body.schemaId ?? body.schema_id);
        if (!Number.isInteger(schemaId)) bad('缺少合法的 schemaId');
        const { query, report } = store.submitQuery(schemaId, body.sql, DEFAULT_LIMITS);
        return send(report.ok ? 201 : 422, { query, report });
      }
      if (method === 'GET' && parts[0] === 'queries') {
        if (parts.length === 1) return send(200, store.listQueries());
        const q = store.getQuery(Number(parts[1]));
        if (!q) return send(404, { code: 'E_VALIDATION', message: 'query 不存在' });
        const sub = parts[2];
        if (!sub) return send(200, q);
        if (sub === 'errors') return send(200, q.report.errors);
        if (sub === 'edges') {
          const edges = [
            ...q.report.outputs.flatMap((o) =>
              o.sources.map((s) => ({ from: s, to: o.name, type: 'value' as const })),
            ),
            ...q.report.conditions.flatMap((c, i) =>
              c.columns.map((s) => ({ from: s, to: `${c.clause}#${i}`, type: 'condition' as const })),
            ),
          ];
          return send(200, edges);
        }
        if (sub === 'fields') {
          const name = (parts[3] ?? '').toLowerCase();
          const f = q.report.outputs.find((o) => o.name === name);
          if (!f) return send(404, { code: 'E_VALIDATION', message: `输出字段 "${name}" 不存在` });
          return send(200, f);
        }
        return send(404, { code: 'E_VALIDATION', message: '未知路径' });
      }
      if (method === 'GET' && parts[0] === 'health') return send(200, { ok: true });
      return send(404, { code: 'E_VALIDATION', message: '未知路径' });
    } catch (e) {
      const err = e as ApiError;
      send(err.statusCode ?? 500, {
        code: err.code ?? 'E_VALIDATION',
        message: err.message,
      });
    }
  });
}

export function startServer(port: number, dataDir: string): Promise<{ port: number; close: () => void }> {
  const store = new Store(dataDir);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: actual, close: () => { server.close(); store.close(); } });
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  startServer(port, dataDir).then(({ port: p }) => {
    console.log(`SQL 血缘分析服务已启动: http://127.0.0.1:${p}  (数据目录: ${dataDir})`);
  });
}
