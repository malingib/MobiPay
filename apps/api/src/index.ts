import app from "./app.js";
import { processDueMerchantWebhookDeliveries } from "./merchantWebhookWorker.js";

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => {
  console.log(`MobiWave Payments API listening on port ${port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down HTTP server.`);
  server.close((error) => {
    if (error) {
      console.error("HTTP server shutdown failed.");
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.env.MERCHANT_WEBHOOK_WORKER_ENABLED === "true") {
  let running = false;
  const worker = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await processDueMerchantWebhookDeliveries(20);
      if (result.deadLettered > 0) console.error(`Merchant webhook deliveries dead-lettered: ${result.deadLettered}`);
    } catch (error) {
      console.error("Merchant webhook worker iteration failed.", error instanceof Error ? error.message : "unknown error");
    } finally {
      running = false;
    }
  }, 15_000);
  worker.unref();
}
