import { config } from "./config.js";

/**
 * Lightweight health check against your local OpenClaw gateway (runs each pipeline).
 * Agents invoke the pipeline via the in-repo OpenClaw plugin `ba-qa` → tool `ba_qa_run_transcript`.
 */
export async function pingOpenClawGateway(): Promise<{ ok: boolean; detail: string }> {
  try {
    const url = new URL("/healthz", config.openclawGatewayUrl);
    const headers: Record<string, string> = {};
    if (config.openclawGatewayToken) {
      headers.Authorization = `Bearer ${config.openclawGatewayToken}`;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(url, { headers, signal: ac.signal }).catch(() => null);
    clearTimeout(t);
    if (!res) {
      return { ok: false, detail: "fetch failed (is the gateway running?)" };
    }
    if (res.ok || res.status === 404) {
      return {
        ok: res.ok,
        detail: res.ok
          ? "gateway reachable"
          : "gateway reachable (no /healthz — 404 is ok for some builds)",
      };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
