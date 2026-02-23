const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// In-memory session store (cleared on restart)
const sessions = new Map();

/**
 * Returns auth configuration from env vars, or null if auth is disabled.
 */
function getAuthConfig() {
  const url = process.env.KEYCLOAK_URL;
  if (!url) return null;

  const realm = process.env.KEYCLOAK_REALM || 'grover';
  const clientId = process.env.KEYCLOAK_CLIENT_ID || 'grover-web';
  const ttl = parseInt(process.env.AUTH_SESSION_TTL, 10) || 86400000; // 24h

  return {
    url: url.replace(/\/$/, ''),
    realm,
    clientId,
    ttl,
    issuer: `${url.replace(/\/$/, '')}/realms/${realm}`,
    jwksUri: `${url.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/certs`,
    tokenEndpoint: `${url.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/token`,
    authEndpoint: `${url.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/auth`,
    logoutEndpoint: `${url.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/logout`,
  };
}

// Lazy-load jose (only when auth is enabled)
let joseModule = null;
async function getJose() {
  if (!joseModule) {
    joseModule = await import('jose');
  }
  return joseModule;
}

let cachedJWKS = null;
async function getJWKS(config) {
  if (!cachedJWKS) {
    const jose = await getJose();
    cachedJWKS = jose.createRemoteJWKSet(new URL(config.jwksUri));
  }
  return cachedJWKS;
}

/**
 * Validate an id_token JWT against Keycloak's JWKS endpoint.
 * Returns the decoded payload or throws.
 */
async function validateIdToken(idToken, config) {
  const jose = await getJose();
  const JWKS = await getJWKS(config);

  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: config.issuer,
    audience: config.clientId,
  });

  const roles = (payload.realm_access && Array.isArray(payload.realm_access.roles))
    ? payload.realm_access.roles
    : [];

  return {
    sub: payload.sub,
    email: payload.email || '',
    name: payload.name || payload.preferred_username || '',
    roles,
  };
}

/**
 * Create a server-side session. Returns the session ID.
 */
function createSession(userId, email, name, roles, ttl) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    userId,
    email,
    name,
    roles: roles || [],
    createdAt: Date.now(),
    ttl,
  });
  return sessionId;
}

/**
 * Parse cookies from a request.
 */
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  }
  return cookies;
}

/**
 * Look up the current session from a request cookie.
 * Returns { userId, email, name } or null.
 */
function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.grover_session;
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check TTL
  if (Date.now() - session.createdAt > session.ttl) {
    sessions.delete(sessionId);
    return null;
  }

  return { userId: session.userId, email: session.email, name: session.name, roles: session.roles || [] };
}

/**
 * Require authentication. Returns user object or sends 401 and returns null.
 * When auth is disabled (config is null), returns a default anonymous user.
 */
function requireAuth(req, res, config) {
  if (!config) {
    return { userId: '_anonymous', email: '', name: '' };
  }

  const user = getSession(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated' }));
    return null;
  }
  return user;
}

function setSessionCookie(res, sessionId, ttl) {
  const maxAge = Math.floor(ttl / 1000);
  const cookie = `grover_session=${sessionId}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'grover_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

/**
 * Handle auth-related routes. Returns true if the route was handled.
 */
async function handleAuthRoute(req, res, config) {
  if (!config) return false;

  const url = new URL(req.url, 'http://localhost');

  // GET /auth/callback — serve the callback HTML page
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const callbackHtml = fs.readFileSync(
      path.join(__dirname, 'auth-callback.html'), 'utf-8'
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(callbackHtml);
    return true;
  }

  // POST /api/auth/session — exchange id_token for a server session
  if (req.method === 'POST' && url.pathname === '/api/auth/session') {
    try {
      const body = await readJsonBody(req);
      const { id_token } = body;
      if (!id_token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing id_token' }));
        return true;
      }

      const user = await validateIdToken(id_token, config);
      const sessionId = createSession(user.sub, user.email, user.name, user.roles, config.ttl);
      setSessionCookie(res, sessionId, config.ttl);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user: { name: user.name, email: user.email } }));
    } catch (e) {
      console.error('[auth] Session creation failed:', e.message);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
    }
    return true;
  }

  // POST /api/auth/logout — destroy local session, return Keycloak logout URL
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const cookies = parseCookies(req);
    const sessionId = cookies.grover_session;
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(res);

    // Build Keycloak end-session URL so the browser also kills the SSO session
    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = encodeURIComponent(`${protocol}://${host}/`);
    const kcLogoutUrl = `${config.logoutEndpoint}?client_id=${config.clientId}&post_logout_redirect_uri=${redirectUri}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logoutUrl: kcLogoutUrl }));
    return true;
  }

  // GET /api/auth/me — return current user info
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = getSession(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user }));
    return true;
  }

  return false;
}

/**
 * Require admin role. Returns user object or sends 401/403 and returns null.
 * When auth is disabled (config is null), always returns 403.
 */
function requireAdmin(req, res, config) {
  if (!config) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin features require authentication to be enabled' }));
    return null;
  }

  const user = getSession(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated' }));
    return null;
  }

  if (!user.roles.includes('admin')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin access required' }));
    return null;
  }

  return user;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  getAuthConfig,
  validateIdToken,
  createSession,
  getSession,
  requireAuth,
  requireAdmin,
  handleAuthRoute,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
};
