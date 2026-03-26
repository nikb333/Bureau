// ================================================================
// Pages Function — API Proxy
// Routes /api/* requests to the Bureau Worker.
// ================================================================

const WORKER_ORIGIN = "api.ops.nikbureau.com";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const targetUrl = `${WORKER_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
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
