import type { Notifier } from "../../ports/notifier.js";

/** Posts a JSON payload to NOTIFY_WEBHOOK_URL; silently no-ops when not configured. */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly url: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log?: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  async notify(event: { kind: string; title: string; message: string; userId: string; data?: Record<string, unknown> }): Promise<boolean> {
    if (!this.url) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...event, sentAt: new Date().toISOString() }), signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch (e) {
      this.log?.warn({ err: (e as Error).message }, "webhook notification failed");
      return false;
    }
  }
}
