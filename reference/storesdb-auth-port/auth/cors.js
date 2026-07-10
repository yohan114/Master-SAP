// Env-configured CORS allow-list. Default (no CORS_ORIGINS set): same-origin only — the safe
// default, since the app serves its own UI. Set CORS_ORIGINS to a comma-separated list of EXACT
// origins (e.g. "https://umms.example.com,https://ops.example.com") to permit specific cross-origin
// browser clients. Credentials (the session cookie) require echoing the exact origin — never "*".
function makeCors(originsEnv) {
  const allow = String(originsEnv == null ? (process.env.CORS_ORIGINS || '') : originsEnv)
    .split(',').map((s) => s.trim()).filter(Boolean);
  const allowSet = new Set(allow);

  return function cors(req, res, next) {
    const origin = req.headers.origin;
    const allowed = !!origin && allowSet.has(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);   // echo exact origin (cookies need this)
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // CORS preflight
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (!allowed) return res.status(403).end();             // cross-origin not on the allow-list
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}

module.exports = { makeCors, cors: makeCors() };
