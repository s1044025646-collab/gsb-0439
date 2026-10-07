import { createServer, findFreePort } from "./server";
import { Service } from "./service";
import { Store } from "./store";
import * as path from "node:path";

async function main() {
  const dataDir = process.env.LINEAGE_DATA_DIR ?? path.join(process.cwd(), "data");
  const preferred = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  const port = await findFreePort(preferred);
  const service = new Service(new Store(dataDir));
  const server = createServer(service);
  server.listen(port, "127.0.0.1", () => {
    console.log(`lineage API listening on http://127.0.0.1:${port} (data: ${dataDir})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
