const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { requireAdmin } = require('./auth');
const { KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD } = require('../config');

// Cached admin token
let adminToken = null;
let adminTokenExpiry = 0;

/**
 * Obtain an admin access token from Keycloak's master realm via password grant.
 */
async function getAdminToken(config) {
  if (adminToken && Date.now() < adminTokenExpiry) return adminToken;

  const tokenUrl = `${config.url}/realms/master/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: KEYCLOAK_ADMIN_USER,
    password: KEYCLOAK_ADMIN_PASSWORD,
  }).toString();

  const data = await httpRequest(tokenUrl, 'POST', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  adminToken = data.access_token;
  // Expire 30s before actual expiry to be safe
  adminTokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
  return adminToken;
}

/**
 * Make an authenticated request to the Keycloak Admin REST API.
 */
async function kcAdmin(config, method, apiPath, body) {
  const token = await getAdminToken(config);
  const url = `${config.url}/admin/realms/${config.realm}${apiPath}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return httpRequest(url, method, body ? JSON.stringify(body) : null, headers);
}

/**
 * Low-level HTTP/HTTPS request helper. Returns parsed JSON or null for 204.
 */
function httpRequest(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: headers || {},
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 201) {
          if (data) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else {
            resolve(null);
          }
          return;
        }
        if (res.statusCode >= 400) {
          let msg = `Keycloak API error ${res.statusCode}`;
          try { const parsed = JSON.parse(data); msg = parsed.errorMessage || parsed.error || msg; } catch {}
          reject(new Error(msg));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Handle admin routes. Returns true if the route was handled.
 */
async function handleAdminRoute(req, res, config, readBody, usageTracker) {
  const url = new URL(req.url, 'http://localhost');

  // GET /api/admin/usage — token usage stats
  if (req.method === 'GET' && url.pathname === '/api/admin/usage') {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;

    const stats = usageTracker ? await usageTracker.getStats() : { totals: {}, byUser: {}, byModel: {}, recent: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return true;
  }

  // GET /admin — serve admin panel HTML
  if (req.method === 'GET' && url.pathname === '/admin') {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;

    const html = fs.readFileSync(path.join(__dirname, 'admin-panel.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return true;
  }

  // GET /api/admin/users — list users
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;

    try {
      const users = await kcAdmin(config, 'GET', '/users?max=100');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(users));
    } catch (e) {
      console.error('[admin] List users failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/admin/users — create user
  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;

    try {
      const raw = await readBody(req);
      const { username, email, firstName, lastName, password, enabled } = JSON.parse(raw);
      if (!username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username is required' }));
        return true;
      }

      const newUser = {
        username,
        email: email || '',
        firstName: firstName || '',
        lastName: lastName || '',
        enabled: enabled !== false,
        emailVerified: true,
        credentials: password ? [{ type: 'password', value: password, temporary: false }] : [],
      };

      await kcAdmin(config, 'POST', '/users', newUser);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[admin] Create user failed:', e.message);
      const status = e.message.includes('exists') ? 409 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // PUT /api/admin/users/:id — update user
  const putMatch = req.method === 'PUT' && url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (putMatch) {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;
    const userId = putMatch[1];

    try {
      const raw = await readBody(req);
      const updates = JSON.parse(raw);
      await kcAdmin(config, 'PUT', `/users/${userId}`, updates);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[admin] Update user failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // POST /api/admin/users/:id/reset-password — reset password
  const pwMatch = req.method === 'POST' && url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/reset-password$/);
  if (pwMatch) {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;
    const userId = pwMatch[1];

    try {
      const raw = await readBody(req);
      const { password } = JSON.parse(raw);
      if (!password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Password is required' }));
        return true;
      }
      await kcAdmin(config, 'PUT', `/users/${userId}/reset-password`, {
        type: 'password', value: password, temporary: false,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[admin] Reset password failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // DELETE /api/admin/users/:id — delete user
  const delMatch = req.method === 'DELETE' && url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (delMatch) {
    const user = await requireAdmin(req, res, config);
    if (!user) return true;
    const userId = delMatch[1];

    try {
      await kcAdmin(config, 'DELETE', `/users/${userId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[admin] Delete user failed:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  return false;
}

module.exports = { handleAdminRoute };
