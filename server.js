const express = require('express');
const fs = require('fs');
const path = require('path');
const ldap = require('ldapjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3003;

const DATA_DIR   = process.env.WEBSITE_SITE_NAME ? '/home/data' : __dirname;
const DB_FILE    = path.join(DATA_DIR, 'propoint.db');
const UPLOAD_DIR = process.env.WEBSITE_SITE_NAME ? '/home/data/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE    = 500 * 1024 * 1024;
const MAX_FILENAME_LEN = 70;

function srvUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function safeName(name) { return name.replace(/[^a-zA-Z0-9.\-_À-ž]/g, '_').slice(0, 200); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${srvUid()}_${safeName(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.length > MAX_FILENAME_LEN)
      return cb(new Error(`Failo pavadinimas per ilgas (max ${MAX_FILENAME_LEN} simbolių).`));
    cb(null, true);
  },
});

// ── Active Directory config ───────────────────────────────────
const LDAP_URL        = 'ldap://192.168.1.100:389';
const LDAP_BASE_DN    = 'DC=hata,DC=local';
const LDAP_USERS_BASE = process.env.LDAP_USERS_BASE || LDAP_BASE_DN;
const LDAP_SVC_DN     = process.env.LDAP_SVC_DN   || 'CN=svc_jira,OU=Service Accounts,DC=hata,DC=local';
const LDAP_SVC_PASS   = process.env.LDAP_SVC_PASS || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database setup ────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const stmtGet    = db.prepare('SELECT value FROM store WHERE key = ?');
const stmtSet    = db.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
const stmtDelete = db.prepare('DELETE FROM store WHERE key = ?');

function dbGet(key) {
  const row = stmtGet.get(key);
  return row ? JSON.parse(row.value) : null;
}
function dbSet(key, value) {
  if (value === null || value === undefined) stmtDelete.run(key);
  else stmtSet.run(key, JSON.stringify(value));
}

// ── Ensure local admin ────────────────────────────────────────
(function ensureLocalAdmin() {
  const users = dbGet('pp-users') || [];
  const hasAdmin = users.find((u) => !u.adAuth && u.username === 'proadmin');
  if (hasAdmin) {
    if (!hasAdmin.password) {
      dbSet('pp-users', users.map((u) =>
        u.id === hasAdmin.id ? { ...u, password: 'Energo99', mustChangePassword: true } : u
      ));
    }
    return;
  }
  dbSet('pp-users', [...users, {
    id: 'admin1',
    name: 'Administratorius',
    username: 'proadmin',
    email: '',
    password: 'Energo99',
    role: 'admin',
    adAuth: false,
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  }]);
  console.log('  👤 Sukurtas vietinis administratorius: proadmin');
})();

// ── Email ─────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: '10.2.1.103',
  port: 25,
  secure: false,
  auth: false,
  tls: { rejectUnauthorized: false },
});
const MAIL_FROM = 'propoint@energolt.eu';
const ADMIN_EMAIL = 'tomas.ruzveltas@energolt.eu';
const APP_URL = process.env.APP_URL || 'http://10.2.1.115:3003';

// ── Users API ─────────────────────────────────────────────────

app.get('/api/store/pp-users', (req, res) => {
  const users = dbGet('pp-users') || [];
  res.json({ key: 'pp-users', value: users.map(({ password, ...u }) => u) });
});

app.put('/api/store/pp-users', (req, res) => {
  const incoming = Array.isArray(req.body.value) ? req.body.value : [];
  const existing = dbGet('pp-users') || [];
  const pwMap = {};
  existing.forEach((u) => { if (u.password) pwMap[u.id] = u.password; });
  const merged = incoming.map((u) =>
    (!u.password && pwMap[u.id]) ? { ...u, password: pwMap[u.id] } : u
  );
  dbSet('pp-users', merged);
  res.json({ ok: true });
});

app.get('/api/store/:key', (req, res) => {
  res.json({ key: req.params.key, value: dbGet(req.params.key) });
});

app.put('/api/store/:key', (req, res) => {
  dbSet(req.params.key, req.body.value);
  res.json({ ok: true });
});

// ── Tasks API ─────────────────────────────────────────────────

// Create task
app.post('/api/tasks', (req, res) => {
  const task = req.body;
  if (!task || !task.id) return res.status(400).json({ error: 'Trūksta duomenų.' });
  const tasks = dbGet('pp-tasks') || [];
  if (tasks.find((t) => t.id === task.id)) return res.json({ ok: true });
  dbSet('pp-tasks', [task, ...tasks]);
  console.log(`  📋 Užduotis sukurta: ${task.name} (${task.id})`);
  res.json({ ok: true });
});

// Get all tasks
app.get('/api/tasks', (req, res) => {
  res.json(dbGet('pp-tasks') || []);
});

// Update task
app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const update = req.body;
  const tasks = dbGet('pp-tasks') || [];
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Užduotis nerasta.' });
  tasks[idx] = { ...tasks[idx], ...update, updatedAt: new Date().toISOString() };
  dbSet('pp-tasks', tasks);
  console.log(`  ✏️  Užduotis atnaujinta: ${tasks[idx].name} → ${tasks[idx].status}`);
  res.json({ ok: true, task: tasks[idx] });
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const tasks = dbGet('pp-tasks') || [];
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return res.status(404).json({ error: 'Užduotis nerasta.' });
  dbSet('pp-tasks', filtered);
  res.json({ ok: true });
});

// Assign task to designer + send email
app.post('/api/tasks/:id/assign', async (req, res) => {
  const { id } = req.params;
  const { designerId, assignedBy } = req.body;
  const tasks = dbGet('pp-tasks') || [];
  const users = dbGet('pp-users') || [];
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Užduotis nerasta.' });
  const designer = users.find((u) => u.id === designerId);
  if (!designer) return res.status(404).json({ error: 'Projektuotojas nerastas.' });

  tasks[idx] = {
    ...tasks[idx],
    assignedTo: designerId,
    assignedToName: designer.name,
    assignedBy,
    assignedAt: new Date().toISOString(),
    status: 'assigned',
    updatedAt: new Date().toISOString(),
  };
  dbSet('pp-tasks', tasks);

  const task = tasks[idx];
  const taskUrl = `${APP_URL}/#task=${encodeURIComponent(task.id)}`;
  const html = buildAssignEmail(designer.name, task, taskUrl);

  if (designer.email) {
    try {
      await mailer.sendMail({ from: MAIL_FROM, to: designer.email, subject: `📋 Nauja užduotis: ${task.name}`, html });
      console.log(`  📨 Priskyrimo laiškas → ${designer.email}`);
    } catch (e) {
      console.error(`  ❌ El. laiško klaida: ${e.message}`);
    }
  }

  res.json({ ok: true, task: tasks[idx] });
});

function buildAssignEmail(designerName, task, url) {
  return `<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#f9fafb;border-radius:12px;overflow:hidden">
  <div style="background:#2563EB;padding:24px 28px">
    <h1 style="color:#fff;margin:0;font-size:20px">📋 Nauja užduotis priskirta</h1>
  </div>
  <div style="padding:24px 28px;background:#fff">
    <p style="color:#374151;font-size:14px;margin:0 0 16px">Sveiki, <strong>${designerName}</strong>! Jums priskirta nauja užduotis.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151">
      <tr><td style="padding:7px 0;color:#6B7280;width:140px">Užduoties pavadinimas</td><td style="padding:7px 0;font-weight:600">${task.name || '—'}</td></tr>
      <tr><td style="padding:7px 0;color:#6B7280">Objektas / adresas</td><td style="padding:7px 0">${task.address || '—'}</td></tr>
      <tr><td style="padding:7px 0;color:#6B7280">Projekto nr.</td><td style="padding:7px 0">${task.projectNumber || '—'}</td></tr>
      <tr><td style="padding:7px 0;color:#6B7280">Terminas</td><td style="padding:7px 0">${task.deadline || '—'}</td></tr>
      <tr><td style="padding:7px 0;color:#6B7280">Prioritetas</td><td style="padding:7px 0">${task.priority || 'Įprastas'}</td></tr>
    </table>
    ${task.description ? `<div style="margin:16px 0;padding:12px;background:#F3F4F6;border-radius:8px;font-size:13px;color:#374151">${task.description}</div>` : ''}
    <div style="text-align:center;margin:24px 0">
      <a href="${url}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px">📂 Atidaryti užduotį sistemoje</a>
    </div>
    <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0">Propoint — Projektuotojų užduočių valdymo sistema</p>
  </div>
</div>`;
}

// ── Coordination (derinimas) API ──────────────────────────────

app.post('/api/coordinations', (req, res) => {
  const coord = req.body;
  if (!coord || !coord.id) return res.status(400).json({ error: 'Trūksta duomenų.' });
  const list = dbGet('pp-coordinations') || [];
  dbSet('pp-coordinations', [coord, ...list]);
  console.log(`  📨 Derinimas sukurtas: ${coord.institution} (${coord.id})`);
  res.json({ ok: true });
});

app.get('/api/coordinations', (req, res) => {
  res.json(dbGet('pp-coordinations') || []);
});

app.patch('/api/coordinations/:id', (req, res) => {
  const { id } = req.params;
  const list = dbGet('pp-coordinations') || [];
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Derinimas nerastas.' });
  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() };
  dbSet('pp-coordinations', list);
  res.json({ ok: true });
});

app.delete('/api/coordinations/:id', (req, res) => {
  const list = dbGet('pp-coordinations') || [];
  dbSet('pp-coordinations', list.filter((c) => c.id !== req.params.id));
  res.json({ ok: true });
});

// Send coordination email to institution
app.post('/api/coordinations/:id/send', async (req, res) => {
  const { id } = req.params;
  const list = dbGet('pp-coordinations') || [];
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Derinimas nerastas.' });
  const coord = list[idx];
  const { to, subject, body } = req.body;
  if (!to || !subject) return res.status(400).json({ error: 'Trūksta gavėjo arba temos.' });
  try {
    await mailer.sendMail({ from: MAIL_FROM, to, subject, html: body || subject });
    list[idx] = { ...coord, sentAt: new Date().toISOString(), status: 'sent', sentTo: to, updatedAt: new Date().toISOString() };
    dbSet('pp-coordinations', list);
    console.log(`  📨 Derinimo laiškas → ${to} | ${subject}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Generic email send ────────────────────────────────────────
app.post('/api/notify/email', async (req, res) => {
  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) return res.status(400).json({ error: 'Trūksta duomenų.' });
  try {
    const info = await mailer.sendMail({ from: MAIL_FROM, to, subject, html });
    console.log(`  📨 El. laiškas → ${to} | ${subject} | ${info.messageId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── File upload ───────────────────────────────────────────────
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Failas per didelis (max 500 MB).' : err.message || 'Įkėlimo klaida.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Failas neįkeltas.' });
    res.json({ id: srvUid(), name: req.file.originalname, filename: req.file.filename, size: req.file.size, url: `/uploads/${req.file.filename}` });
  });
});

app.delete('/api/files/:filename', (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || /[/\\]/.test(filename))
    return res.status(400).json({ error: 'Neteisingas failo pavadinimas.' });
  const filePath = path.join(UPLOAD_DIR, filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {
    return res.status(500).json({ error: 'Klaida trinant failą.' });
  }
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// ── Auth: local ───────────────────────────────────────────────
app.post('/api/auth/local', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Trūksta prisijungimo duomenų.' });
  const users = dbGet('pp-users') || [];
  const user = users.find((u) => !u.adAuth && u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Vartotojas nerastas.' });
  if (user.password !== password) return res.status(401).json({ error: 'Neteisingas slaptažodis.' });
  const { password: _pw, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ── Auth: change password ─────────────────────────────────────
app.post('/api/auth/change-password', (req, res) => {
  const { userId, oldPassword, newPassword, forceChange } = req.body;
  if (!userId || !newPassword) return res.status(400).json({ error: 'Trūksta duomenų.' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Slaptažodis per trumpas (min. 4 simboliai).' });
  const users = dbGet('pp-users') || [];
  const user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (user.adAuth) return res.status(400).json({ error: 'AD vartotojai slaptažodžio nekeičia čia.' });
  if (!user.mustChangePassword && !forceChange && user.password !== oldPassword)
    return res.status(401).json({ error: 'Neteisingas dabartinis slaptažodis.' });
  const updated = { ...user, password: newPassword, mustChangePassword: !!forceChange };
  dbSet('pp-users', users.map((u) => (u.id === userId ? updated : u)));
  const { password: _pw, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// ── Auth: LDAP ────────────────────────────────────────────────
app.post('/api/auth/ldap', (req, res) => {
  const rawUsername = (req.body.username || '').trim();
  const username = rawUsername.replace(/@[^@]*$/, '').toLowerCase();
  const { password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Trūksta prisijungimo duomenų.' });

  let responded = false;
  function safeRespond(code, body) { if (!responded) { responded = true; res.status(code).json(body); } }
  function makeClient() {
    return ldap.createClient({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000, reconnect: false });
  }

  const authClient = makeClient();
  authClient.on('error', (err) => {
    console.error('[LDAP] Ryšio klaida:', err.message);
    safeRespond(503, { error: 'Nepavyko prisijungti prie Active Directory.' });
  });

  authClient.bind(`${username}@hata.local`, password, (bindErr) => {
    authClient.destroy();
    if (bindErr) return safeRespond(401, { error: 'Neteisingas vartotojo vardas arba slaptažodis.' });

    const svcClient = makeClient();
    svcClient.on('error', () => finishLogin(res, username, '', username));
    svcClient.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (svcErr) => {
      if (svcErr) { svcClient.destroy(); return finishLogin(res, username, '', username); }
      const opts = { filter: `(&(objectClass=user)(sAMAccountName=${username}))`, scope: 'sub', attributes: ['givenName', 'sn', 'mail', 'userPrincipalName'], timeLimit: 8 };
      svcClient.search(LDAP_USERS_BASE, opts, (searchErr, result) => {
        if (searchErr) { try { svcClient.destroy(); } catch (_) {} return finishLogin(res, username, '', username); }
        let attrs = {}, done = false;
        function finish() {
          if (done) return; done = true;
          try { svcClient.destroy(); } catch (_) {}
          const upn = attrs.userPrincipalName || '';
          const email = attrs.mail || (!upn.toLowerCase().endsWith('@hata.local') ? upn : '');
          const name = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;
          finishLogin(res, username, email, name);
        }
        result.on('searchEntry', (entry) => {
          (entry.attributes || []).forEach((a) => { attrs[a.type] = a.values && a.values.length === 1 ? a.values[0] : a.values; });
        });
        result.on('searchReference', () => {});
        result.on('error', () => finish());
        result.on('end', () => finish());
      });
    });
  });
});

function finishLogin(res, username, email, displayName) {
  let users = dbGet('pp-users') || [];
  const usernameLower = username.toLowerCase();
  const byUsername = users.find((u) => u.adAuth && u.username.toLowerCase() === usernameLower);
  const byEmail    = email ? users.find((u) => u.adAuth && u.email === email) : null;
  let user = byUsername || byEmail || null;

  if (!user) {
    user = { id: srvUid(), name: displayName, email, username, role: 'pending', adAuth: true, mustChangePassword: false, password: null, createdAt: new Date().toISOString() };
    dbSet('pp-users', [...users, user]);
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#2563EB;padding:20px 28px"><h2 style="color:#fff;margin:0">👤 Naujas vartotojas laukia patvirtinimo</h2></div>
      <div style="padding:20px 28px;background:#fff">
        <p><strong>${displayName}</strong> (${email || username}) užsiregistravo Propoint sistemoje.</p>
        <a href="${APP_URL}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:700">Priskirti rolę</a>
      </div>
    </div>`;
    mailer.sendMail({ from: MAIL_FROM, to: ADMIN_EMAIL, subject: `👤 Naujas vartotojas: ${displayName}`, html })
      .catch((e) => console.error('  ❌ Registracijos laiško klaida:', e.message));
    console.log(`  👤 Naujas AD vartotojas: ${displayName} (${email || username})`);
  } else {
    user = { ...user, name: displayName, email: email || user.email, username };
    dbSet('pp-users', users.map((u) => (u.id === user.id ? user : u)));
  }
  res.json({ user });
}

// ── Users management ──────────────────────────────────────────

app.post('/api/users', (req, res) => {
  const { name, email, password, role } = req.body;
  const ALLOWED = ['admin', 'designer'];
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Trūksta duomenų.' });
  if (!ALLOWED.includes(role)) return res.status(400).json({ error: 'Neteisinga rolė.' });
  if (password.length < 4) return res.status(400).json({ error: 'Slaptažodis per trumpas.' });
  const users = dbGet('pp-users') || [];
  if (users.find((u) => !u.adAuth && u.email === email.trim())) return res.status(409).json({ error: 'El. paštas jau naudojamas.' });
  const newUser = { id: srvUid(), name: name.trim(), email: email.trim(), password, role, adAuth: false, mustChangePassword: true, createdAt: new Date().toISOString() };
  dbSet('pp-users', [...users, newUser]);
  const { password: _pw, ...safeUser } = newUser;
  res.status(201).json({ user: safeUser });
});

app.delete('/api/users/:id', (req, res) => {
  const users = dbGet('pp-users') || [];
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (user.role === 'admin') {
    const others = users.filter((u) => u.role === 'admin' && u.id !== user.id);
    if (others.length === 0) return res.status(400).json({ error: 'Negalima ištrinti paskutinio administratoriaus.' });
  }
  dbSet('pp-users', users.filter((u) => u.id !== req.params.id));
  res.json({ ok: true });
});

app.patch('/api/users/:id/role', (req, res) => {
  const ALLOWED = ['admin', 'designer', 'pending'];
  const role = (req.body.role || '').trim();
  if (!ALLOWED.includes(role)) return res.status(400).json({ error: 'Neteisinga rolė.' });
  const users = dbGet('pp-users') || [];
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (user.role === 'admin' && role !== 'admin') {
    if (users.filter((u) => u.role === 'admin' && u.id !== user.id).length === 0)
      return res.status(400).json({ error: 'Negalima pašalinti paskutinio administratoriaus.' });
  }
  const updated = { ...user, role };
  dbSet('pp-users', users.map((u) => (u.id === req.params.id ? updated : u)));
  const { password: _, ...safeUser } = updated;
  res.json({ user: safeUser });
});

app.patch('/api/users/:id/email', (req, res) => {
  const users = dbGet('pp-users') || [];
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  const updated = { ...user, email: (req.body.email || '').trim() };
  dbSet('pp-users', users.map((u) => (u.id === req.params.id ? updated : u)));
  const { password: _, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// ── Reminders ─────────────────────────────────────────────────
// Check for overdue tasks and send reminder emails (called by cron or manually)
app.post('/api/reminders/check', async (req, res) => {
  const tasks = dbGet('pp-tasks') || [];
  const users = dbGet('pp-users') || [];
  const now = new Date();
  let sent = 0;
  const notified = [];

  for (const task of tasks) {
    if (!task.deadline || ['completed', 'rejected'].includes(task.status)) continue;
    const deadline = new Date(task.deadline);
    const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
    if (daysLeft > 3) continue;

    const designer = task.assignedTo ? users.find((u) => u.id === task.assignedTo) : null;
    if (!designer || !designer.email) continue;

    const label = daysLeft < 0 ? `pavėluota ${Math.abs(daysLeft)} d.` : daysLeft === 0 ? 'šiandien' : `liko ${daysLeft} d.`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <div style="background:${daysLeft < 0 ? '#DC2626' : '#D97706'};padding:18px 24px">
        <h2 style="color:#fff;margin:0">⏰ Užduoties terminas: ${label}</h2>
      </div>
      <div style="padding:20px 24px;background:#fff">
        <p><strong>${task.name}</strong><br/>${task.address || ''}</p>
        <p>Terminas: <strong>${task.deadline}</strong></p>
        <a href="${APP_URL}/#task=${encodeURIComponent(task.id)}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px">Atidaryti užduotį</a>
      </div>
    </div>`;
    try {
      await mailer.sendMail({ from: MAIL_FROM, to: designer.email, subject: `⏰ Terminas: ${task.name} (${label})`, html });
      sent++;
      notified.push({ task: task.name, to: designer.email, daysLeft });
    } catch (e) {
      console.error(`  ❌ Priminimo laiškas nepavyko: ${e.message}`);
    }
  }
  console.log(`  🔔 Priminimai: išsiųsta ${sent}`);
  res.json({ sent, notified });
});

// ── Fallback ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🏗️  Propoint veikia: http://localhost:${PORT}\n`);
  console.log(`  🗄️  Duomenų bazė: ${DB_FILE}`);
});
