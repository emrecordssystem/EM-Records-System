(function () {
  const productionApiUrl = 'https://emrsystem.up.railway.app';
  const googleClientId = '745311488374-q7j7ggcbvrvin3qu2ahuq80akmbtmtvp.apps.googleusercontent.com';
  const hostname = window.location.hostname;
  const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);
  const apiBaseUrl = isLocalhost
    ? 'http://localhost:3000'
    : hostname.endsWith('.vercel.app')
      ? productionApiUrl
      : window.location.origin;

  window.PROFELECT_API_BASE_URL = apiBaseUrl;
  window.PROFELECT_GOOGLE_CLIENT_ID = googleClientId;
  console.log('[API CONFIG] Environment:', { isLocalhost, apiBaseUrl, hostname: window.location.hostname, googleConfigured: Boolean(googleClientId) });

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (resource, options) {
    if (typeof resource === 'string' && resource.startsWith('/api/')) {
      const fullUrl = `${apiBaseUrl}${resource}`;
      console.debug('[FETCH]', fullUrl);
      return originalFetch(fullUrl, options).catch(err => {
        console.error('[FETCH ERROR]', resource, err.message);
        throw err;
      });
    }

    return originalFetch(resource, options);
  };
})();
