import { readFile } from "node:fs/promises";
import { createPreallocatedSupervisor } from "../../../../packages/adapters/src/preallocated-supervisor.js";

const settings = JSON.parse(await readFile("/config/config.json", "utf8"));
const server = await createPreallocatedSupervisor({
  ...settings,
  controlToken: settings.control_token,
  stateFile: "/state/pool.json",
});
server.listen(7091, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
