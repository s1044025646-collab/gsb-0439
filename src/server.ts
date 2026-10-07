import * as http from "node:http";
import * as net from "node:net";
import { Service } from "./service";
import { AnalysisError } from "./errors";

export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AnalysisError([{ code: "E_VALIDATION", message: "请求体必须是 JSON" }]);
  }
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const m = req.method ?? "GET";
      const body = m === "POST" ? await readBody(req) : null;

      if (m === "POST" && p === "/schemas") return send(201, service.createSchema(body));
      if (m === "GET" && p === "/schemas") return send(200, service.store.listSchemas());
      if (m === "POST" && p === "/queries") return send(201, service.submitQuery(body));
      if (m === "POST" && p === "/analyze") return send(200, service.analyze(body));
      if (m === "GET" && p === "/analyses") return send(200, service.history());
      let match = p.match(/^\/analyses\/(\d+)$/);
      if (m === "GET" && match) return send(200, service.getAnalysis(Number(match[1])));
      match = p.match(/^\/analyses\/(\d+)\/errors$/);
      if (m === "GET" && match) return send(200, service.getErrors(Number(match[1])));
      match = p.match(/^\/analyses\/(\d+)\/edges$/);
      if (m === "GET" && match) return send(200, service.getEdges(Number(match[1])));
      return send(404, { code: "E_NOT_FOUND", message: `未知路由 ${m} ${p}` });
    } catch (e) {
      if (e instanceof AnalysisError) return send(400, { diagnostics: e.diagnostics });
      return send(500, { code: "E_INTERNAL", message: String((e as Error).message || e) });
    }
  });
}
