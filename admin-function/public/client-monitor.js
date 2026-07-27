(() => {
  const nativeFetch = window.fetch.bind(window);
  const monitored = /^\/api\/(?:dashboard|logs|monitoring|vendors|principals|connections(?:\/[^/?#]+(?:\/(?:grants|credential|status))?)?)$/;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const shouldMonitor = url.origin === window.location.origin && monitored.test(url.pathname);
    const started = performance.now();
    let response;
    let status = 0;
    try { response = await nativeFetch(input, init); status = response.status; return response; }
    finally {
      if (shouldMonitor) {
        const event = { apiPath: url.pathname, pagePath: window.location.pathname, method, status, durationMs: Math.min(60000, Math.round(performance.now() - started)) };
        nativeFetch('/api/client-events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), keepalive: true }).catch(() => undefined);
      }
    }
  };
})();
