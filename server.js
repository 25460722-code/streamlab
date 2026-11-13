// StreamLab — plataforma ligera de streaming en vivo (estilo Twitch) con fines didácticos
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const bcrypt = require('bcryptjs');
const NodeMediaServer = require('node-media-server');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const MEDIA = path.join(__dirname, 'media');
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
fs.mkdirSync(MEDIA, { recursive: true });

const CATEGORIES = ['Videojuegos', 'Programación', 'Educación', 'Música', 'Charlas', 'Arte'];

const newKey = () => 'sk_' + crypto.randomBytes(12).toString('hex');
const validUser = (u) => /^[a-z0-9_]{3,20}$/.test(u || '');

function parseCookies(str = '') {
  return Object.fromEntries(str.split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}

function userFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) || null;
}

const publicUser = (u) => u && ({ id: u.id, username: u.username, title: u.title, category: u.category, is_live: !!u.is_live, bio: u.bio });

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = userFromToken(parseCookies(req.headers.cookie).sl_token); next(); });
const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Inicia sesión' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/hls.js', express.static(path.join(__dirname, 'node_modules/hls.js/dist')));
app.use('/media', express.static(MEDIA, {
  setHeaders: (res, file) => { if (file.endsWith('.m3u8')) res.setHeader('Cache-Control', 'no-cache'); }
}));

function startSession(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie', `sl_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
}

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const { password } = req.body;
  if (!validUser(username)) return res.status(400).json({ error: 'Usuario: 3-20 caracteres (a-z, 0-9, _)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Ese usuario ya existe' });
  const info = db.prepare('INSERT INTO users (username, password_hash, stream_key, title, category) VALUES (?, ?, ?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 10), newKey(), `Stream de ${username}`, 'Charlas');
  startSession(res, info.lastInsertRowid);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash)) return res.status(401).json({ error: 'Credenciales incorrectas' });
  startSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(parseCookies(req.headers.cookie).sl_token || '');
  res.setHeader('Set-Cookie', 'sl_token=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

const viewers = (u) => io.sockets.adapter.rooms.get('ch:' + u)?.size || 0;
const decorate = (u) => ({
  ...publicUser(u),
  viewers: viewers(u.username),
  followers: db.prepare('SELECT COUNT(*) n FROM follows WHERE channel_id = ?').get(u.id).n,
  thumb: `/media/live/${u.username}/thumb.jpg?t=${Math.floor(Date.now() / 30000)}`,
});

app.get('/api/categories', (req, res) => res.json(CATEGORIES.map((name) => ({
  name, live: db.prepare('SELECT COUNT(*) n FROM users WHERE is_live = 1 AND category = ?').get(name).n,
}))));

app.get('/api/channels', (req, res) => {
  const { category, live } = req.query;
  let sql = 'SELECT * FROM users WHERE 1=1';
  const p = [];
  if (category) { sql += ' AND category = ?'; p.push(category); }
  if (live === '1') sql += ' AND is_live = 1';
  sql += ' ORDER BY is_live DESC, username';
  res.json(db.prepare(sql).all(...p).map(decorate).sort((a, b) => b.is_live - a.is_live || b.viewers - a.viewers));
});

app.get('/api/following', auth, (req, res) => {
  res.json(db.prepare('SELECT u.* FROM follows f JOIN users u ON u.id = f.channel_id WHERE f.follower_id = ? ORDER BY u.is_live DESC').all(req.user.id).map(decorate));
});

app.get('/api/channels/:username', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'Canal no encontrado' });
  const following = req.user ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?').get(req.user.id, u.id) : false;
  res.json({ ...decorate(u), following, hls: `/media/live/${u.username}/index.m3u8`, vods: listVods(u.username) });
});

app.post('/api/channels/:username/follow', auth, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'Canal no encontrado' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'No puedes seguirte a ti mismo' });
  const exists = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?').get(req.user.id, u.id);
  if (exists) db.prepare('DELETE FROM follows WHERE follower_id = ? AND channel_id = ?').run(req.user.id, u.id);
  else db.prepare('INSERT INTO follows (follower_id, channel_id) VALUES (?, ?)').run(req.user.id, u.id);
  res.json({ following: !exists, followers: db.prepare('SELECT COUNT(*) n FROM follows WHERE channel_id = ?').get(u.id).n });
});

app.get('/api/dashboard', auth, (req, res) => res.json({
  ...publicUser(req.user), stream_key: req.user.stream_key, categories: CATEGORIES,
  rtmp_url: `rtmp://${PUBLIC_HOST || req.hostname}:${RTMP_PORT}/live`,
  obs_key: `${req.user.username}?key=${req.user.stream_key}`,
}));

app.put('/api/dashboard', auth, (req, res) => {
  const title = String(req.body.title || '').slice(0, 120) || req.user.title;
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : req.user.category;
  const bio = String(req.body.bio ?? req.user.bio ?? '').slice(0, 300);
  db.prepare('UPDATE users SET title = ?, category = ?, bio = ? WHERE id = ?').run(title, category, bio, req.user.id);
  io.to('ch:' + req.user.username).emit('channel:update', { title, category });
  res.json({ ok: true });
});

app.post('/api/dashboard/regenerate-key', auth, (req, res) => {
  const key = newKey();
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, req.user.id);
  res.json({ stream_key: key, obs_key: `${req.user.username}?key=${key}` });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

function listVods(username) {
  const dir = path.join(MEDIA, 'live', username);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'))
    .map((f) => ({ file: f, url: `/media/live/${username}/${f}`, size_mb: +(fs.statSync(path.join(dir, f)).size / 1048576).toFixed(1) }))
    .filter((v) => v.size_mb > 0.05).sort((a, b) => b.file.localeCompare(a.file));
}

app.get('/c/:username', (_req, res) => res.sendFile(path.join(__dirname, 'public/channel.html')));

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  const user = userFromToken(parseCookies(socket.handshake.headers.cookie).sl_token);
  let room = null;
  socket.on('join', (channel) => {
    if (room) socket.leave(room);
    room = 'ch:' + String(channel);
    socket.join(room);
    io.to(room).emit('viewers', viewers(String(channel)));
  });
  socket.on('chat', (text) => {
    if (!room) return;
    if (!user) return socket.emit('chat:error', 'Inicia sesión para chatear');
    text = String(text || '').trim().slice(0, 300);
    if (!text) return;
    const now = Date.now();
    if (socket.lastMsg && now - socket.lastMsg < 700) return socket.emit('chat:error', 'Más despacio');
    socket.lastMsg = now;
    io.to(room).emit('chat', { user: user.username, text, color: colorFor(user.username), at: now });
  });
  socket.on('disconnecting', () => {
    if (room) setTimeout(() => io.to(room).emit('viewers', viewers(room.slice(3))), 50);
  });
});

function colorFor(name) {
  const palette = ['#ff7a59', '#2ec4b6', '#ffbf47', '#7aa2ff', '#ff5d8f', '#6ee7a8', '#c792ea'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

const nms = new NodeMediaServer({
  logType: 1,
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: Number(process.env.NMS_HTTP_PORT || 8000), mediaroot: MEDIA, allow_origin: '*', host: '127.0.0.1' },
});

const thumbTimers = new Map();
const transProcs = new Map();

function snapshot(username) {
  const out = path.join(MEDIA, 'live', username, 'thumb.jpg');
  spawn(FFMPEG, ['-y', '-loglevel', 'error', '-i', `rtmp://127.0.0.1:${RTMP_PORT}/live/${username}`, '-frames:v', '1', '-vf', 'scale=480:-2', out]);
}

function startTranscode(username) {
  const dir = path.join(MEDIA, 'live', username);
  fs.mkdirSync(dir, { recursive: true });
  const m3u8 = path.join(dir, 'index.m3u8');
  const seg = path.join(dir, '%d.ts');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const mp4 = path.join(dir, `${stamp}.mp4`);

  const args = [
    '-y', '-loglevel', 'error',
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}/live/${username}`,
    '-c:v', 'copy', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '4', '-hls_flags', 'delete_segments',
    '-hls_segment_filename', seg, m3u8,
  ];
  if (process.env.RECORD_VOD !== 'false') {
    args.push('-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', mp4);
  }
  const proc = spawn(FFMPEG, args);
  transProcs.set(username, proc);
}

nms.on('prePublish', (id, streamPath, args) => {
  const parts = streamPath.split('/');
  const appName = parts[1];
  const username = parts[2];
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  // Validación flexible que acepta la clave tanto por args.key como por query string directa
  const clientKey = args.key || (parts[3] && parts[3].replace('key=', ''));
  
  if (appName !== 'live' || !u || (clientKey && clientKey !== u.stream_key)) {
    console.log(`[RTMP] Rechazado ${streamPath} (clave inválida o usuario no encontrado)`);
    return nms.getSession(id).reject();
  }
  console.log(`[RTMP] ${username} inició transmisión correctamente`);
});

nms.on('postPublish', (_id, streamPath) => {
  const username = streamPath.split('/')[2];
  db.prepare('UPDATE users SET is_live = 1 WHERE username = ?').run(username);
  startTranscode(username);
  io.emit('live', { username, live: true });
  setTimeout(() => snapshot(username), 3000);
  thumbTimers.set(username, setInterval(() => snapshot(username), 30000));
});

nms.on('donePublish', (_id, streamPath) => {
  const username = streamPath.split('/')[2];
  db.prepare('UPDATE users SET is_live = 0 WHERE username = ?').run(username);
  clearInterval(thumbTimers.get(username)); thumbTimers.delete(username);
  const proc = transProcs.get(username);
  if (proc) { proc.kill('SIGINT'); transProcs.delete(username); }
  io.emit('live', { username, live: false });
  console.log(`[RTMP] ${username} terminó transmisión`);
});

db.prepare('UPDATE users SET is_live = 0').run();
nms.run();
server.listen(PORT, () => console.log(`StreamLab web en http://localhost:${PORT} · RTMP en rtmp://localhost:${RTMP_PORT}/live`));
