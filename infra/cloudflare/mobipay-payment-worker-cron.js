export default {
  async fetch() {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await fetch(new URL("/api/worker", env.MOBIPAY_API_URL), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.MOBIPAY_WORKER_CRON_SECRET}`,
          "content-type": "application/json",
          "user-agent": "MobiPay-Worker-Scheduler/1.0"
        },
        body: JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
        signal: AbortSignal.timeout(55_000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`MobiPay worker endpoint returned HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
    })());
  }
};
