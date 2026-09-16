/** CLI entry: `pnpm db:seed` — seeds the demo data set into the configured database. */
import "../../env-file.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { loadConfig, isMemoryDatabase } = await import("../../config.js");
  const { createContainer } = await import("../../container.js");
  const { seedDemo } = await import("../../seed/demo.js");
  const cfg = loadConfig();
  if (isMemoryDatabase(cfg)) {
    console.log("DATABASE_URL=memory: demo data is seeded automatically at startup (DEMO_SEED=true). Nothing to do.");
    process.exit(0);
  }
  const container = await createContainer(cfg, { logger: { info: (o, m) => console.log(m ?? "", o), warn: (o, m) => console.warn(m ?? "", o), error: (o, m) => console.error(m ?? "", o), debug: () => undefined } });
  try {
    const result = await seedDemo(container);
    console.log("Demo data seeded:", result);
  } finally {
    await container.close();
  }
}
