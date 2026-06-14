(function () {
  const renderApiUrl = 'https://emrsystem-9gng.onrender.com';
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const apiBaseUrl = isLocalhost ? 'http://localhost:3000' : renderApiUrl.replace(/\/$/, '');

  window.PROFELECT_API_BASE_URL = apiBaseUrl;
  console.log('[API CONFIG] Environment:', { isLocalhost, apiBaseUrl, hostname: window.location.hostname });

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
