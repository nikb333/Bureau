// ================================================================
// Pages Function — API Proxy
// Routes /api/* requests to the Bureau Worker with service key auth.
// Cloudflare Access protects this entire Pages domain, so only
// authenticated Google Workspace users can reach this proxy.
// ================================================================

const WORKER_ORIGIN = "https://bureau.nik-d88.workers.dev";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Debug endpoint — diagnoses proxy + Worker auth chain
  if (url.pathname === "/api/debug-proxy") {
    const rawKey = env.BUREAU_SERVICE_KEY;
    const keyExists = !!rawKey;
    const keyLength = rawKey ? rawKey.length : 0;
    const trimmedLength = rawKey ? rawKey.trim().length : 0;
    const keyPrefix = rawKey ? rawKey.trim().slice(0, 4) + "..." : "MISSING";
    const hasWhitespace = keyLength !== trimmedLength;

    // Test the Worker health endpoint directly
    let workerReachable = false;
    let workerStatus = null;
    try {
      const healthRes = await fetch(`${WORKER_ORIGIN}/api/health`);
      workerReachable = true;
      workerStatus = await healthRes.json();
    } catch (e) {
      workerStatus = { error: e.message };
    }

    // Test the Worker with the service key to see if auth passes
    let authTest = null;
    try {
      const testHeaders = new Headers();
      testHeaders.set("X-Bureau-Service-Key", (rawKey || "").trim());
      testHeaders.set("Origin", "https://bureau-a04.pages.dev");
      const authRes = await fetch(`${WORKER_ORIGIN}/api/orders`, { headers: testHeaders });
      authTest = { status: authRes.status, ok: authRes.ok };
      if (!authRes.ok) {
        authTest.body = await authRes.text();
      }
    } catch (e) {
      authTest = { error: e.message };
    }

    return new Response(JSON.stringify({
      proxyRunning: true,
      keyExists,
      keyLength,
      trimmedLength,
      keyPrefix,
      hasWhitespace,
      workerReachable,
      workerStatus,
      authTest,
      envKeys: Object.keys(env).filter(k => k !== "BUREAU_SERVICE_KEY"),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.set("X-Bureau-Service-Key", (env.BUREAU_SERVICE_KEY || "").trim());
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);
    const responseHeaders = new Headers(response.headers);
    // Remove CORS headers — same-origin now, browser doesn't need them
    responseHeaders.delete("Access-Control-Allow-Origin");
    responseHeaders.delete("Access-Control-Allow-Methods");
    responseHeaders.delete("Access-Control-Allow-Headers");
    responseHeaders.delete("Access-Control-Max-Age");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Proxy error: " + e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
