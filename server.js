'use strict';
/*
 * Nha Khoa Trẻ · Máy chủ tư vấn nội bộ
 * - Bảo vệ trang tư vấn bằng đăng nhập
 * - Một mật khẩu chung để vào trang; trang /admin để đổi mật khẩu + xem nhật ký
 * Không cần cài thư viện ngoài (chỉ cần Node.js >= 16).
 *
 * Chạy:            node server.js
 * Đặt mật khẩu: node server.js set-admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_DAYS = parseFloat(process.env.SESSION_DAYS || '7');
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const COOKIE = 'nkt_sid';

const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOG_FILE = path.join(DATA_DIR, 'login-log.jsonl');

// Các file xem được khi chưa đăng nhập (logo trên trang đăng nhập)
const PUBLIC_FILES = new Set(['/assets/nkt-logo-header.png']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};

/* ---------------- Lưu trữ ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });

function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

let db = readJson(DB_FILE, { admin: null });
let dbMtime = 0;
function saveDb() { writeJsonAtomic(DB_FILE, db); try { dbMtime = fs.statSync(DB_FILE).mtimeMs; } catch (e) {} }
try { dbMtime = fs.statSync(DB_FILE).mtimeMs; } catch (e) {}
// Nạp lại nếu file bị sửa từ bên ngoài (ví dụ lệnh set-admin)
function refreshDb() {
  try {
    const m = fs.statSync(DB_FILE).mtimeMs;
    if (m !== dbMtime) { const d = readJson(DB_FILE, null); if (d) db = d; dbMtime = m; }
  } catch (e) {}
}

/* ---------------- Mật khẩu ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + h;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, salt, h] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !h) return false;
  const calc = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(h, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}

/* ---------------- Phiên đăng nhập ---------------- */
let sessions = readJson(SESS_FILE, {});
let sessSaveTimer = null;
function saveSessions() {
  clearTimeout(sessSaveTimer);
  sessSaveTimer = setTimeout(() => writeJsonAtomic(SESS_FILE, sessions), 300);
}
function sessionKey(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function createSession(role, uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[sessionKey(token)] = { role, uid, created: Date.now(), exp: Date.now() + SESSION_MS };
  saveSessions();
  return token;
}
function destroySessionsWhere(fn) {
  let changed = false;
  for (const k of Object.keys(sessions)) if (fn(sessions[k])) { delete sessions[k]; changed = true; }
  if (changed) saveSessions();
}
setInterval(() => destroySessionsWhere(s => s.exp < Date.now()), 3600 * 1000).unref();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) { return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [COOKIE + '=' + (token || ''), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAgeSec];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Trả về thông tin phiên đăng nhập hoặc null
function getAuth(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const key = sessionKey(token);
  const s = sessions[key];
  if (!s) return null;
  if (s.exp < Date.now()) { delete sessions[key]; saveSessions(); return null; }
  if (s.role !== 'admin' || !db.admin) { delete sessions[key]; saveSessions(); return null; }
  if (db.admin.updatedAt && s.created < Date.parse(db.admin.updatedAt)) { delete sessions[key]; saveSessions(); return null; }
  return { role: 'admin', key, username: 'admin', name: 'Quản trị viên' };
}

/* ---------------- Nhật ký đăng nhập ---------------- */
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (local) {
    const xr = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0];
    if (xr) return String(xr).trim();
  }
  return remote.replace(/^::ffff:/, '');
}
function writeLog(entry) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) { console.error('Không ghi được nhật ký:', e.message); }
}
function readLogs(limit) {
  let lines = [];
  for (const f of [LOG_FILE + '.old', LOG_FILE]) {
    try { lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch (e) {}
  }
  return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

/* ---------------- Chống dò mật khẩu ---------------- */
const failures = new Map(); // ip -> { n, first }
const MAX_FAILS = 10, FAIL_WINDOW = 15 * 60 * 1000;
function isBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW) { failures.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
function addFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}

/* ---------------- Tiện ích HTTP ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
// Chặn gửi form từ trang web khác (CSRF)
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (o.host === host) return true;
    return o.hostname === host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  } catch (e) { return false; }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/* ---------------- Trang tĩnh ---------------- */
const viewCache = {};
function view(name) {
  if (!viewCache[name] || process.env.NODE_ENV === 'development') viewCache[name] = fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8');
  return viewCache[name];
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(html);
}

let indexCache = null, indexMtime = 0;
function renderIndex(auth) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  const st = fs.statSync(file);
  if (!indexCache || st.mtimeMs !== indexMtime) { indexCache = fs.readFileSync(file, 'utf8'); indexMtime = st.mtimeMs; }
  const bar = view('userbar.html')
    .replace('{{ADMIN_LINK}}', '<a href="/admin">Quản trị</a>');
  const i = indexCache.lastIndexOf('</body>');
  return i >= 0 ? indexCache.slice(0, i) + bar + indexCache.slice(i) : indexCache + bar;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function serveFile(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=604800', ETag: etag, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? st.size - parseInt(m[2], 10) : parseInt(m[1], 10);
        let end = m[1] !== '' && m[2] !== '' ? parseInt(m[2], 10) : st.size - 1;
        if (m[1] === '') end = st.size - 1;
        if (isNaN(start) || start < 0 || start >= st.size || end < start) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end();
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, auth) {
  const method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Yêu cầu không hợp lệ.' });

  // Đăng nhập
  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    if (isBlocked(ip)) return sendJson(res, 429, { error: 'Sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.' });
    let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Dữ liệu không hợp lệ.' }); }
    const password = String(body.password || '');
    if (!db.admin || !verifyPassword(password, db.admin.hash)) {
      addFailure(ip);
      writeLog({ t: new Date().toISOString(), ip, ok: false, reason: 'Sai mật khẩu', ua });
      return sendJson(res, 401, { error: 'Mật khẩu không đúng.' });
    }
    const role = 'admin';
    failures.delete(ip);
    const token = createSession(role, null);
    writeLog({ t: new Date().toISOString(), ip, ok: true, reason: 'Đăng nhập thành công', ua });
    setSessionCookie(req, res, token, Math.floor(SESSION_MS / 1000));
    return sendJson(res, 200, { ok: true, role });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    if (auth) { delete sessions[auth.key]; saveSessions(); }
    setSessionCookie(req, res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    if (!auth) return sendJson(res, 401, { error: 'Chưa đăng nhập.' });
    return sendJson(res, 200, { role: auth.role, username: auth.username, name: auth.name });
  }

  // ---- Từ đây trở xuống chỉ admin ----
  if (!pathname.startsWith('/api/admin/')) return sendJson(res, 404, { error: 'Không tìm thấy.' });
  if (!auth) return sendJson(res, 401, { error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
  if (auth.role !== 'admin') return sendJson(res, 403, { error: 'Chỉ quản trị viên mới làm được việc này.' });

  const sub = pathname.slice('/api/admin'.length);

  if (sub === '/sessions' && method === 'GET') {
    const n = Object.values(sessions).filter(x => x.role === 'admin' && x.exp > Date.now()).length;
    return sendJson(res, 200, { active: n });
  }
  if (sub === '/logout-others' && method === 'POST') {
    const mine = sessions[auth.key];
    destroySessionsWhere(x => x !== mine);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/logs' && method === 'GET') {
    return sendJson(res, 200, { logs: readLogs(1000) });
  }

  if (sub === '/password' && method === 'POST') {
    let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Dữ liệu không hợp lệ.' }); }
    if (!verifyPassword(String(body.current || ''), db.admin.hash)) return sendJson(res, 400, { error: 'Mật khẩu hiện tại không đúng.' });
    const nw = String(body.next || '');
    if (nw.length < 8) return sendJson(res, 400, { error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
    db.admin.hash = hashPassword(nw); saveDb();
    const mine = sessions[auth.key];
    destroySessionsWhere(s => s.role === 'admin' && s !== mine);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Không tìm thấy.' });
}

/* ---------------- Định tuyến ---------------- */
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { res.writeHead(400); return res.end(); }
  refreshDb();
  const auth = getAuth(req);

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, auth);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    if (pathname === '/login') {
      if (!db.admin) return sendHtml(res, view('setup-needed.html'));
      if (auth) return redirect(res, '/');
      return sendHtml(res, view('login.html'));
    }
    if (pathname === '/admin' || pathname === '/admin/') {
      if (!auth) return redirect(res, '/login?next=/admin');
      if (auth.role !== 'admin') return redirect(res, '/');
      return sendHtml(res, view('admin.html'));
    }
    if (PUBLIC_FILES.has(pathname)) return serveFile(req, res, pathname);

    if (!auth) {
      const wantsHtml = pathname === '/' || pathname.endsWith('.html') || (req.headers.accept || '').includes('text/html');
      if (wantsHtml) return redirect(res, '/login');
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Cần đăng nhập');
    }
    if (pathname === '/' || pathname === '/index.html') return sendHtml(res, renderIndex(auth));
    return serveFile(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Lỗi máy chủ.' });
    else res.end();
  }
});

/* ---------------- Lệnh đặt mật khẩu admin ---------------- */
let rlSingleton = null, muted = false;
const lineQueue = [], waiters = [];
function rl() {
  if (!rlSingleton) {
    rlSingleton = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    const orig = rlSingleton._writeToOutput.bind(rlSingleton);
    rlSingleton._writeToOutput = s => { if (!muted) orig(s); else if (!/[\r\n]/.test(s) && s.length === 1) orig('*'); };
    rlSingleton.on('line', l => { if (waiters.length) waiters.shift()(l); else lineQueue.push(l); });
  }
  return rlSingleton;
}
function nextLine() { rl(); return lineQueue.length ? Promise.resolve(lineQueue.shift()) : new Promise(r => waiters.push(r)); }
async function ask(question) { process.stdout.write(question); return nextLine(); }
async function askHidden(question) {
  process.stdout.write(question); muted = true;
  const ans = await nextLine(); muted = false; process.stdout.write('\n'); return ans;
}
async function setAdmin() {
  console.log('=== Đặt mật khẩu truy cập ===');
  const username = 'admin';
  const p1 = await askHidden('Mật khẩu mới (ít nhất 8 ký tự): ');
  if (p1.length < 8) { console.log('Mật khẩu quá ngắn.'); process.exit(1); }
  const p2 = await askHidden('Nhập lại mật khẩu: ');
  if (p1 !== p2) { console.log('Hai lần nhập không khớp.'); process.exit(1); }
  db = { admin: { username, hash: hashPassword(p1), updatedAt: new Date().toISOString() } };
  saveDb(); // các phiên admin cũ tự hết hiệu lực
  if (rlSingleton) rlSingleton.close();
  console.log('Đã lưu mật khẩu. Mọi thiết bị đang đăng nhập sẽ phải đăng nhập lại.');
  process.exit(0);
}

if (process.argv[2] === 'set-admin') {
  setAdmin();
} else {
  server.listen(PORT, HOST, () => {
    console.log(`Nha Khoa Trẻ đang chạy tại http://${HOST}:${PORT}`);
    if (!db.admin) console.log('Chưa đặt mật khẩu. Chạy: node server.js set-admin');
  });
}
