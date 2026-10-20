import app from "./app.js";

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
