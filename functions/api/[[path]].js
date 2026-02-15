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

  // Temporary debug endpoint — remove after confirming proxy works
  if (url.pathname === "/api/debug-proxy") {
    const keyExists = !!env.BUREAU_SERVICE_KEY;
    const keyLength = env.BUREAU_SERVICE_KEY ? env.BUREAU_SERVICE_KEY.length : 0;
    const keyPrefix = env.BUREAU_SERVICE_KEY ? env.BUREAU_SERVICE_KEY.slice(0, 4) + "..." : "MISSING";
    return new Response(JSON.stringify({
      proxyRunning: true,
      keyExists,
      keyLength,
      keyPrefix,
      envKeys: Object.keys(env).filter(k => k !== "BUREAU_SERVICE_KEY"),
    }), { headers: { "Content-Type": "application/json" } });
  }

  const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.set("X-Bureau-Service-Key", env.BUREAU_SERVICE_KEY || "");
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
