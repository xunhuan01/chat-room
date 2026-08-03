const express = require('express');
const http = require('http');
const https = require('https');
const iconv = require('iconv-lite');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const multer = require('multer');
const FormData = require('form-data');
const sharp = require('sharp');

// Prevent crash on broken pipe (console.log when stdout closes)
const origLog = console.log;
console.log = function() { try { origLog.apply(console, arguments); } catch(e) {} };
const origError = console.error;
console.error = function() { try { origError.apply(console, arguments); } catch(e) {} };

const app = express();
app.use(cookieParser());
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ─── Telegram Bot config ──────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN || 'PLACEHOLDER_BOT_TOKEN';

const TELEGRAM_CHAT_ID = process.env.GROUP_ID || '-1004384134428';
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── store mappings ───────────────────────────────────────────
const visitorTopics = new Map();  // visitorId -> { topicId, name }
const topicVisitors = new Map();  // topicId -> visitorId

// ─── Visitor sessions ─────────────────────────────────────────
const sessions = new Map();

const adjectives = ['安静的', '好奇的', '神秘的', '快乐的', '忧郁的', '兴奋的', '慵懒的'];
const nouns = ['小猫', '企鹅', '熊猫', '海豚', '狐狸', '兔子', '考拉', '仓鼠', '树懒', '鹦鹉'];
const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#2980b9'];

function randomVisitor() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const color = colors[Math.floor(Math.random() * colors.length)];
  return { name: `${adj}${noun}`, color };
}

// ─── Telegram API helper (via proxy) ────────────────────────
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7897';
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

async function tgAPI(method, params = {}) {
  const url = `${TG_API}/${method}`;
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      agent: proxyAgent,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Visitor IP → city (for TG push) ──────────────────────
const ipLocationCache = new Map();  // ip -> { city, ts }

function getClientIP(socket) {
  const h = socket.handshake.headers || {};
  let ip = h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;
  return (ip || '').replace('::ffff:', '');
}

function getIPLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return Promise.resolve(null);
  const cached = ipLocationCache.get(ip);
  if (cached && Date.now() - cached.ts < 24 * 3600 * 1000) return Promise.resolve(cached.city);
  return new Promise((resolve) => {
    const url = `https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`;
    const req = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://whois.pconline.com.cn/' },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(iconv.decode(Buffer.concat(chunks), 'gbk'));
          let city = '';
          if (j.pro) city += j.pro;
          if (j.city) city += j.city;
          if (!city) city = j.addr || '';
          if (city) ipLocationCache.set(ip, { city, ts: Date.now() });
          resolve(city || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';
const MEMBER_PASSWORD = process.env.MEMBER_PASSWORD || 'CHANGE_ME_MEMBER_PW';
const MEMBER_TOPIC_ID = process.env.MEMBER_TOPIC_ID || '';
const POSTS_TOPIC_ID = process.env.POSTS_TOPIC_ID || '';
const DATA_DIR = path.join(__dirname, 'data');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const POSTS_MEDIA_DIR = path.join(DATA_DIR, 'posts_media');
const MEMBER_LOG_FILE = path.join(DATA_DIR, 'member_logs.json');
const MEMBER_PROFILES_FILE = path.join(DATA_DIR, 'member_profiles.json');

app.use(express.json());

// Multer config - image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDataDir();
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('仅允许图片格式'));
  }
});

// Serve uploaded images
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', etag: true, lastModified: true }));

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadVisitors() {
  try {
    ensureDataDir();
    if (!fs.existsSync(VISITORS_FILE)) return {};
    return JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8')) || {};
  } catch (e) { console.error('loadVisitors:', e.message); return {}; }
}

function saveVisitors(visitors) {
  try {
    ensureDataDir();
    fs.writeFileSync(VISITORS_FILE, JSON.stringify(visitors, null, 2));
  } catch (e) { console.error('saveVisitors:', e.message); }
}


// ─── Chat log persistence ──────────────────────────────────
const CHAT_LOGS_DIR = path.join(DATA_DIR, 'chat_logs');
const PENDING_DIR = path.join(DATA_DIR, 'pending');

function ensureChatDirs() {
  ensureDataDir();
  if (!fs.existsSync(CHAT_LOGS_DIR)) fs.mkdirSync(CHAT_LOGS_DIR, { recursive: true });
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function saveChatLog(visitorId, entry) {
  try {
    ensureChatDirs();
    const file = path.join(CHAT_LOGS_DIR, visitorId + '.json');
    let logs = [];
    if (fs.existsSync(file)) {
      logs = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    logs.push(entry);
    fs.writeFileSync(file, JSON.stringify(logs, null, 2));
  } catch (e) { console.error('saveChatLog:', e.message); }
}

function loadChatLog(visitorId) {
  try {
    ensureChatDirs();
    const file = path.join(CHAT_LOGS_DIR, visitorId + '.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch (e) { console.error('loadChatLog:', e.message); return []; }
}

function savePendingMessage(visitorId, msg) {
  try {
    ensureChatDirs();
    const file = path.join(PENDING_DIR, visitorId + '.json');
    let msgs = [];
    if (fs.existsSync(file)) {
      msgs = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    msgs.push(msg);
    fs.writeFileSync(file, JSON.stringify(msgs, null, 2));
  } catch (e) { console.error('savePendingMessage:', e.message); }
}

function loadPendingMessages(visitorId) {
  try {
    ensureChatDirs();
    const file = path.join(PENDING_DIR, visitorId + '.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch (e) { return []; }
}

function clearPendingMessages(visitorId) {
  try {
    const file = path.join(PENDING_DIR, visitorId + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}

// ─── 帖子墙 (posts wall) ──────────────────────────────────
function loadPosts() {
  try {
    ensureDataDir();
    if (!fs.existsSync(POSTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')) || [];
  } catch (e) { console.error('loadPosts:', e.message); return []; }
}

function savePosts(posts) {
  try {
    ensureDataDir();
    fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2));
  } catch (e) { console.error('savePosts:', e.message); }
}

function addPost(post) {
  const posts = loadPosts();
  posts.unshift(post);  // 新帖在最前
  savePosts(posts);
  return post;
}

// 帖子图片上传（存 posts_media，不随每日清理删除）
const postStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDataDir();
    if (!fs.existsSync(POSTS_MEDIA_DIR)) fs.mkdirSync(POSTS_MEDIA_DIR, { recursive: true });
    cb(null, POSTS_MEDIA_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const uploadPost = multer({
  storage: postStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('仅允许图片格式'));
  }
});

// ─── 会员群数据层（日志持久化 + 72h 清理 + 会员档案） ────────
const MEMBER_LOG_MAX_AGE = 72 * 3600 * 1000;  // 72 小时
const MEMBER_AVATARS = ['🐼','🦊','🐯','🐻','🐨','🐰','🐹','🐸','🐵','🐷','🐺','🦁','🐮','🐶','🐱','🦄','🐧','🐢','🦉','🐙'];
const MEMBER_BG_COLORS = ['#e8f4ff','#f0f7ee','#fdf3e3','#f3e8ff','#e6f7f5','#ffe9ec','#eef2ff','#f5f5dc','#fff0e6','#e8fff0'];

function loadMemberLogs() {
  try {
    ensureDataDir();
    if (!fs.existsSync(MEMBER_LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(MEMBER_LOG_FILE, 'utf8')) || [];
  } catch (e) { console.error('loadMemberLogs:', e.message); return []; }
}

function saveMemberLogs(logs) {
  try {
    ensureDataDir();
    fs.writeFileSync(MEMBER_LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (e) { console.error('saveMemberLogs:', e.message); }
}

function appendMemberLog(entry) {
  const logs = loadMemberLogs();
  logs.push(entry);
  // 顺带清理超 72h 的旧消息
  const cutoff = Date.now() - MEMBER_LOG_MAX_AGE;
  const filtered = logs.filter(m => m.time >= cutoff);
  if (filtered.length !== logs.length) {
    console.log('[member] 清理过期消息', logs.length - filtered.length, '条');
  }
  saveMemberLogs(filtered);
  return filtered;
}

function loadMemberProfiles() {
  try {
    ensureDataDir();
    if (!fs.existsSync(MEMBER_PROFILES_FILE)) return {};
    return JSON.parse(fs.readFileSync(MEMBER_PROFILES_FILE, 'utf8')) || {};
  } catch (e) { console.error('loadMemberProfiles:', e.message); return {}; }
}

function saveMemberProfiles(profiles) {
  try {
    ensureDataDir();
    fs.writeFileSync(MEMBER_PROFILES_FILE, JSON.stringify(profiles, null, 2));
  } catch (e) { console.error('saveMemberProfiles:', e.message); }
}

// 根据 memberId 取或建会员档案（昵称 + emoji 头像 + 背景色）
function getOrCreateMemberProfile(memberId) {
  const profiles = loadMemberProfiles();
  if (memberId && profiles[memberId]) {
    return profiles[memberId];
  }
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const profile = {
    nick: `${adj}${noun}`,
    avatar: MEMBER_AVATARS[Math.floor(Math.random() * MEMBER_AVATARS.length)],
    bg: MEMBER_BG_COLORS[Math.floor(Math.random() * MEMBER_BG_COLORS.length)],
    color: colors[Math.floor(Math.random() * colors.length)],
  };
  if (memberId) {
    profiles[memberId] = profile;
    saveMemberProfiles(profiles);
  }
  return profile;
}

// ─── Image upload ───────────────────────────────────────────
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  res.json({ url: '/uploads/' + req.file.filename });
});
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '图片太大，最大5MB' });
  if (err.message === '仅允许图片格式') return res.status(400).json({ error: err.message });
  next(err);
});

// ─── TG sendPhoto (via proxy) ─────────────────────────────
async function tgSendPhoto(chatId, topicId, imagePath, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (topicId) form.append('message_thread_id', topicId);
  form.append('photo', fs.createReadStream(imagePath));
  if (caption) form.append('caption', caption);
  const url = TG_API + '/sendPhoto';
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: form.getHeaders(),
      agent: proxyAgent,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// ─── sharp 图片压缩（TG 下载 & 网页上传共用）───────────────
// GIF 跳过；PNG/webp/jpg 压缩到 1280px 内、quality 70；压缩后比原图大则保留原图
async function compressImageWithSharp(savePath) {
  try {
    const size = fs.statSync(savePath).size;
    const ext = path.extname(savePath).toLowerCase();
    if (ext === '.gif') return;
    const tmpPath = savePath + '.tmp';
    const pipeline = sharp(savePath).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true });
    if (ext === '.png') {
      await pipeline.png({ quality: 70, compressionLevel: 9 }).toFile(tmpPath);
    } else if (ext === '.webp') {
      await pipeline.webp({ quality: 70 }).toFile(tmpPath);
    } else {
      // jpg / jpeg / 其他
      await pipeline.jpeg({ quality: 70 }).toFile(tmpPath);
    }
    const compressedSize = fs.statSync(tmpPath).size;
    if (compressedSize < size) {
      fs.unlinkSync(savePath);
      fs.renameSync(tmpPath, savePath);
      console.log('[sharp] compressed', path.basename(savePath), size, '->', compressedSize);
    } else {
      fs.unlinkSync(tmpPath);
      console.log('[sharp] kept original', path.basename(savePath), size, '(compressed was larger:', compressedSize, ')');
    }
  } catch (e) {
    console.error('[sharp] compress failed:', e.message);
    // 压缩失败用原图，不影响流程
  }
}

// ─── Download Telegram file ───────────────────────────────
async function downloadTGFile(fileId, targetDir) {
  const dir = targetDir || UPLOADS_DIR;
  const info = await tgAPI('getFile', { file_id: fileId });
  if (!info.ok || !info.result) {
    console.error('downloadTGFile: getFile failed', info);
    return null;
  }
  const filePath = info.result.file_path;
  const ext = path.extname(filePath) || '.jpg';
  const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  const savePath = path.join(dir, filename);
  // Ensure target directory exists
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
  const url = 'https://api.telegram.org/file/bot' + TELEGRAM_BOT_TOKEN + '/' + filePath;
  console.log('downloadTGFile: downloading', filePath, 'via proxy');
  return new Promise((resolve) => {
    const file = fs.createWriteStream(savePath);
    https.get(url, { agent: proxyAgent }, (res) => {
      if (res.statusCode !== 200) {
        console.error('downloadTGFile: HTTP', res.statusCode, 'for', filePath);
        res.resume();
        try { fs.unlinkSync(savePath); } catch {}
        resolve(null);
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(async () => {
          const size = fs.statSync(savePath).size;
          console.log('downloadTGFile: saved', filename, size + ' bytes');
          // sharp 压缩（GIF 跳过；压缩后比原图大就保留原图）
          await compressImageWithSharp(savePath);
          resolve((dir === POSTS_MEDIA_DIR ? '/posts-media/' : '/uploads/') + filename);
        });
      });
    }).on('error', (err) => {
      console.error('downloadTGFile: connection error', err.message);
      try { fs.unlinkSync(savePath); } catch {}
      resolve(null);
    });
  });
}

// downloadTGFile wrapper with retry (max 2 retries, 1s interval)
async function downloadTGFileWithRetry(fileId, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const result = await downloadTGFile(fileId);
      if (result) return result;
      // downloadTGFile resolves null on failure — treat as throw to trigger retry
      throw new Error('downloadTGFile returned null');
    } catch (e) {
      console.error('[TG] downloadTGFile attempt ' + (i+1) + '/' + (maxRetries+1) + ' failed: ' + e.message);
      if (i < maxRetries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'visitor.html'));
});

app.get('/admin', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) {
    return res.status(403).send('需要密码访问管理面板。请在 URL 后面加上 ?pw=你的密码');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 帖子墙删除（仅管理员）
app.delete('/api/posts/:id', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: '仅管理员可删除' });
  }
  const id = req.params.id;
  const posts = loadPosts();
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: '帖子不存在' });
  posts.splice(idx, 1);
  savePosts(posts);
  res.json({ ok: true });
});

// ─── 帖子墙 + 会员群 页面路由 ─────────────────────────────
const crypto = require('crypto');
const MEMBER_AUTH_HASH = crypto.createHash('sha256').update(MEMBER_PASSWORD).digest('hex');
const MEMBER_COOKIE = 'member_auth';
const ADMIN_COOKIE = 'admin_auth';

function isMember(req) {
  return req.cookies && req.cookies[MEMBER_COOKIE] === MEMBER_AUTH_HASH;
}
function isAdmin(req) {
  return req.cookies && req.cookies[ADMIN_COOKIE] === ADMIN_PASSWORD;
}
// 会员或管理员都可访问
function canAccessPosts(req) {
  return isMember(req) || isAdmin(req);
}

// 会员登录（帖子墙真锁入口）
const MEMBER_COOKIE_MAXAGE = 10 * 365 * 24 * 3600 * 1000;  // 10年 ≈ 永久
const LOGIN_FAIL_FILE = path.join(DATA_DIR, 'login_fails.json');
const MAX_LOGIN_ATTEMPTS = 10;             // 最多尝试次数
const LOCK_DURATION = 7 * 24 * 3600 * 1000; // 锁定 7 天

// 真实 IP（Cloudflare Tunnel 用 CF-Connecting-IP，防伪造）
// 兼容两种入参：Express req 或 Socket.IO socket
function getClientIP(req) {
  try {
    // Socket.IO socket → handshake.headers / handshake.address
    if (req && req.handshake) {
      const h = req.handshake.headers || {};
      return h['cf-connecting-ip'] || (req.handshake.address || 'unknown');
    }
    // Express req
    if (req && req.headers) {
      return req.headers['cf-connecting-ip'] || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    }
  } catch (e) {}
  return 'unknown';
}

function loadLoginFails() {
  try {
    if (!fs.existsSync(LOGIN_FAIL_FILE)) return {};
    return JSON.parse(fs.readFileSync(LOGIN_FAIL_FILE, 'utf8')) || {};
  } catch (e) { return {}; }
}

function saveLoginFails(fails) {
  try { fs.writeFileSync(LOGIN_FAIL_FILE, JSON.stringify(fails, null, 2)); } catch (e) {}
}

app.post('/api/member-login', (req, res) => {
  const { pw } = req.body || {};
  const ip = getClientIP(req);
  const fails = loadLoginFails();
  const rec = fails[ip] || { count: 0, lockedUntil: 0 };

  // 锁定期内：直接拒绝（正确密码也不行）
  if (rec.lockedUntil > Date.now()) {
    const daysLeft = Math.ceil((rec.lockedUntil - Date.now()) / 86400000);
    return res.status(429).json({ error: `尝试次数过多，已锁定${daysLeft}天后可再试` });
  }
  // 锁定已过期：清零重新开始
  if (rec.lockedUntil > 0) {
    rec.count = 0;
    rec.lockedUntil = 0;
  }

  if (pw !== MEMBER_PASSWORD) {
    rec.count++;
    if (rec.count >= MAX_LOGIN_ATTEMPTS) {
      rec.lockedUntil = Date.now() + LOCK_DURATION;
      rec.count = 0;
      console.log(`[lock] IP ${ip} 密码尝试${MAX_LOGIN_ATTEMPTS}次失败，锁定7天`);
    }
    fails[ip] = rec;
    saveLoginFails(fails);
    const remaining = MAX_LOGIN_ATTEMPTS - rec.count;
    return res.status(403).json({ error: rec.lockedUntil > Date.now() ? '尝试次数过多，已锁定7天' : `密码错误（还可尝试${remaining}次）` });
  }

  // 成功：清除该 IP 的失败记录
  delete fails[ip];
  saveLoginFails(fails);
  res.cookie(MEMBER_COOKIE, MEMBER_AUTH_HASH, { httpOnly: true, maxAge: MEMBER_COOKIE_MAXAGE, sameSite: 'lax', secure: true });
  res.json({ ok: true });
});

app.get('/posts', (req, res) => {
  // 管理员可带 ?pw= 直接种 admin cookie（发帖入口）
  if (req.query.pw === ADMIN_PASSWORD) {
    res.cookie(ADMIN_COOKIE, ADMIN_PASSWORD, { httpOnly: true, maxAge: MEMBER_COOKIE_MAXAGE, sameSite: 'lax', secure: true });
  }
  res.sendFile(path.join(__dirname, 'public', 'posts.html'));
});

// 前端判断当前身份（显示发帖按钮用）
app.get('/api/admin-check', (req, res) => {
  res.json({ admin: isAdmin(req), member: isMember(req) });
});

app.get('/member', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'member.html'));
});

// 帖子墙图片上传（独立目录，不随每日清理删除；需 admin 密码，种 admin cookie）
app.post('/upload-post', (req, res, next) => {
  if (req.query.pw !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: '密码错误' });
  }
  res.cookie(ADMIN_COOKIE, ADMIN_PASSWORD, { httpOnly: true, maxAge: MEMBER_COOKIE_MAXAGE, sameSite: 'lax', secure: true });
  next();
}, uploadPost.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  // 网页上传的图片同样压缩（和 TG 通道一致）
  await compressImageWithSharp(req.file.path);
  res.json({ url: '/posts-media/' + req.file.filename });
});

// 帖子图片保护：仅已登录会员/管理员可访问（<img> 自动带 cookie）
app.use('/posts-media', (req, res, next) => {
  if (!canAccessPosts(req)) {
    return res.status(401).send('需要会员密码');
  }
  next();
});
app.use('/posts-media', express.static(POSTS_MEDIA_DIR, { maxAge: '30d', etag: true, lastModified: true }));

// 帖子墙 API（会员/管理员登录后可见）
app.get('/api/posts', (req, res) => {
  if (!isMember(req) && !isAdmin(req)) {
    return res.status(401).json({ error: '需要会员密码' });
  }
  res.json(loadPosts());
});

// admin 网页表单发帖（校验 ADMIN_PASSWORD）
app.post('/api/posts', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: '密码错误' });
  }
  const { text, image } = req.body || {};
  if (!text && !image) return res.status(400).json({ error: '内容为空' });
  const post = addPost({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    text: (text || '').trim(),
    image: image || '',
    author: 'admin',
    time: new Date().toISOString()
  });
  res.json({ ok: true, post });
});

// ─── Cookie -> Topic mapping (persistent) ────────────────────
const COOKIE_TOPIC_FILE = path.join(DATA_DIR, 'cookie_topics.json');

function loadCookieTopics() {
  try {
    ensureDataDir();
    if (!fs.existsSync(COOKIE_TOPIC_FILE)) return {};
    return JSON.parse(fs.readFileSync(COOKIE_TOPIC_FILE, 'utf8')) || {};
  } catch (e) { return {}; }
}

function saveCookieTopics(topics) {
  try {
    ensureDataDir();
    fs.writeFileSync(COOKIE_TOPIC_FILE, JSON.stringify(topics, null, 2));
  } catch (e) {}
}

// ─── Socket.IO ────────────────────────────────────────────────

io.on('connection', (socket) => {
  const isAdmin = socket.handshake.query.role === 'admin';

  if (isAdmin) {
    console.log('Admin connected:', socket.id);

    socket.emit('sessions', Array.from(sessions.values()).map(s => ({
      id: s.id, name: s.name, color: s.color, createdAt: s.createdAt
    })));
    // Also check if admin has cookies - visitor gateway doesn't need it for admin

    socket.on('admin-message', (data) => {
      // Save admin reply to chat log
      const targetSocket = io.sockets.sockets.get(data.visitorId);
      if (targetSocket) {
        const v = sessions.get(data.visitorId);
        if (v && v.legacyId) {
          saveChatLog(v.legacyId, {
            from: 'admin',
            type: data.type || 'text',
            text: data.text || '',
            url: data.url || '',
            timestamp: new Date().toISOString()
          });
        }
      }
      const vs = io.sockets.sockets.get(data.visitorId);
      if (vs) vs.emit('admin-message', { text: data.text || '', type: data.type || 'text', url: data.url || '' });
    });

    socket.on('disconnect', () => console.log('Admin disconnected'));

  } else {
    // Visitor connected
    const visitorIdFromCookie = socket.handshake.headers.cookie
      ? decodeURIComponent(socket.handshake.headers.cookie.split('; ').find(c => c.startsWith('visitorId='))?.split('=')[1] || '')
      : '';
    
    const visitors = loadVisitors();
    let visitor;
    
    if (visitorIdFromCookie && visitors[visitorIdFromCookie]) {
      // Returning visitor
      const v = visitors[visitorIdFromCookie];
      visitor = { id: socket.id, name: v.name, color: v.color, createdAt: v.createdAt, legacyId: visitorIdFromCookie };
      console.log(`Returning visitor: ${visitor.name} (cookie ${visitorIdFromCookie})`);
    } else {
      // New visitor
      visitor = { ...randomVisitor(), id: socket.id, createdAt: new Date().toISOString() };
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      visitors[newId] = { name: visitor.name, color: visitor.color, createdAt: visitor.createdAt };
      saveVisitors(visitors);
      visitor.legacyId = newId;
      console.log(`New visitor: ${visitor.name} (id ${newId})`);
    }
    
    sessions.set(socket.id, visitor);
    console.log(`Connected: ${visitor.name} (${socket.id})`);

    io.emit('visitor-joined', {
      id: visitor.id, name: visitor.name, color: visitor.color, createdAt: visitor.createdAt,
      legacyId: visitor.legacyId || ''
    });
    socket.emit('welcome', { name: visitor.name, color: visitor.color, visitorId: visitor.legacyId || '' });

    // Send chat history to returning visitor
    if (visitor.legacyId) {
      const history = loadChatLog(visitor.legacyId);
      if (history.length > 0) {
        socket.emit('chat-history', history);
        console.log('Sent ' + history.length + ' history messages to ' + visitor.name);
      }
      // Deliver pending offline messages
      const pending = loadPendingMessages(visitor.legacyId);
      if (pending.length > 0) {
        for (const pm of pending) {
          socket.emit('admin-message', { text: pm.text || '', type: pm.type || 'text', url: pm.url || '' });
          // Save to chat log so pending messages persist on future refresh
          saveChatLog(visitor.legacyId, {
            from: 'admin',
            type: pm.type || 'text',
            url: pm.url || '',
            text: pm.text || '',
            timestamp: pm.timestamp || new Date().toISOString()
          });
        }
        clearPendingMessages(visitor.legacyId);
        console.log('Delivered ' + pending.length + ' pending messages to ' + visitor.name);
      }
    }

    // 创建 TG 话题
    createTopicForVisitor(visitor, socket.id, getClientIP(socket));

    socket.on('visitor-message', async (data) => {
      const { text, type, url } = data;
      const v = sessions.get(socket.id);
      io.emit('visitor-message', {
        visitorId: socket.id,
        visitorName: v ? v.name : '未知',
        visitorColor: v ? v.color : '#999',
        text: text || '',
        type: type || 'text',
        url: url || '',
        timestamp: new Date().toISOString()
      });
      console.log('' + (v ? v.name : '?') + ': ' + (type === 'image' ? '[图片]' : (text || '')));
      // Save visitor message to chat log
      if (v && v.legacyId) {
        saveChatLog(v.legacyId, {
          from: 'visitor',
          type: type || 'text',
          text: text || '',
          url: url || '',
          timestamp: new Date().toISOString()
        });
      }

      const topic = visitorTopics.get(socket.id);
      if (topic) {
        try {
          if (type === 'image' && url) {
            const imgPath = path.join(UPLOADS_DIR, path.basename(url));
            if (fs.existsSync(imgPath)) {
              tgSendPhoto(TELEGRAM_CHAT_ID, topic.topicId, imgPath, text || '').catch(e => console.error('[TG] sendPhoto failed:', e.message));
            }
          } else if (text) {
            await tgAPI('sendMessage', {
              chat_id: TELEGRAM_CHAT_ID,
              message_thread_id: topic.topicId,
              text: text
            });
          }
        } catch (e) { console.error('TG send error:', e.message); }
      }
    });

    socket.on('disconnect', () => {
      const v = sessions.get(socket.id);
      sessions.delete(socket.id);
      console.log('Visitor left: ' + (v ? v.name : socket.id));
      io.emit('visitor-left', { visitorId: socket.id });

      const topic = visitorTopics.get(socket.id);
      if (topic) {
        tgAPI('sendMessage', {
          chat_id: TELEGRAM_CHAT_ID,
          message_thread_id: topic.topicId,
          text: `🚪 ${topic.name} 已离开对话`,
        }).catch(() => {});
      }
    });
  }
});

// ─── 会员群 (member room) ─────────────────────────────────
const memberNS = io.of('/member');

memberNS.on('connection', (socket) => {
  const pw = socket.handshake.query.pw || '';
  // 密码或已登录 cookie（帖子墙/会员群共享登录状态）二选一
  const cookies = socket.handshake.headers.cookie || '';
  const authedByCookie = cookies.indexOf(MEMBER_COOKIE + '=' + MEMBER_AUTH_HASH) !== -1;
  if (pw !== MEMBER_PASSWORD && !authedByCookie) {
    socket.emit('member-auth-fail', { message: '密码错误' });
    socket.disconnect(true);
    return;
  }
  // 会员档案：memberId（cookie 传入）→ 固定昵称 + emoji 头像
  const memberId = (socket.handshake.query.memberId || '').toString().slice(0, 40);
  const profile = getOrCreateMemberProfile(memberId);
  const member = {
    id: socket.id,
    memberId,
    nick: profile.nick,
    avatar: profile.avatar,
    bg: profile.bg,
    color: profile.color,
  };
  memberNS.emit('member-joined', { id: socket.id, nick: member.nick, avatar: member.avatar, bg: member.bg });
  console.log('Member joined:', member.nick, member.avatar, socket.id);

  // 回放近 72h 历史消息
  const history = loadMemberLogs();
  if (history.length > 0) {
    socket.emit('member-history', history);
    console.log('Member history sent:', history.length, 'msgs');
  }

  socket.on('member-message', (data) => {
    const text = (data && data.text || '').toString().slice(0, 2000);
    const type = data && data.type || 'text';
    const url = data && data.url || '';
    if (!text && !url) return;
    const payload = { id: socket.id, memberId, nick: member.nick, avatar: member.avatar, bg: member.bg, color: member.color, text, type, url, time: Date.now() };
    memberNS.emit('member-message', payload);
    // 持久化（顺带清理 72h 前的旧消息）
    appendMemberLog(payload);
    // TG 转发到会员话题
    if (MEMBER_TOPIC_ID) {
      if (type === 'image' && url) {
        const imgPath = path.join(UPLOADS_DIR, path.basename(url));
        if (fs.existsSync(imgPath)) {
          tgSendPhoto(TELEGRAM_CHAT_ID, MEMBER_TOPIC_ID, imgPath, text).catch(() => {});
        }
      } else if (text) {
        tgAPI('sendMessage', {
          chat_id: TELEGRAM_CHAT_ID,
          message_thread_id: MEMBER_TOPIC_ID,
          text: `👤 ${member.nick}: ${text}`
        }).catch(() => {});
      }
    }
  });

  socket.on('disconnect', () => {
    memberNS.emit('member-left', { id: socket.id });
    console.log('Member left:', member.nick);
  });
});

// ─── Create/Reuse Telegram Forum Topic ───────────────────────
const cookieTopics = loadCookieTopics();

async function createTopicForVisitor(visitor, socketId, clientIP) {
  const legacyId = visitor.legacyId;
  const loc = await getIPLocation(clientIP);
  const locText = loc ? `\n📍 ${loc}` : '';

  // Already has a persistent topic for this cookie
  if (legacyId && cookieTopics[legacyId]) {
    const topicId = cookieTopics[legacyId];
    visitorTopics.set(socketId, { topicId, name: visitor.name, legacyId: visitor.legacyId });
    topicVisitors.set(topicId, socketId);

    tgAPI('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: topicId,
      text: `🟢 ${visitor.name} 重新上线${locText}`,
    }).catch(() => {});
    console.log(`Reusing topic: ${visitor.name} → topicId=${topicId}`);
    return;
  }

  // Create new topic
  try {
    const res = await tgAPI('createForumTopic', {
      chat_id: TELEGRAM_CHAT_ID,
      name: visitor.name,
      icon_color: 0x6FB9F0,
    });
    if (!res.ok) {
      console.error('createForumTopic failed:', JSON.stringify(res));
      return;
    }
    const topicId = res.result.message_thread_id;
    visitorTopics.set(socketId, { topicId, name: visitor.name, legacyId: visitor.legacyId });
    topicVisitors.set(topicId, socketId);

    if (legacyId) {
      cookieTopics[legacyId] = topicId;
      saveCookieTopics(cookieTopics);
    }

    await tgAPI('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: topicId,
      text: `🟢 ${visitor.name} 加入了对话${locText}`,
    });
    console.log('Topic created: ' + visitor.name + ' -> topicId=' + topicId + ' (cookie=' + legacyId + ')');
  } catch (err) {
    console.error('Failed to create topic:', err.message);
  }
}

// ─── Telegram Long Poll (via proxy) ──────────────────────────
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const url = `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=["message"]`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, { agent: proxyAgent }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); }
        });
      }).on('error', reject);
    });
    if (data.ok && data.result) {
      for (const upd of data.result) {
        lastUpdateId = upd.update_id;
        handleTGMessage(upd.message);
      }
    }
  } catch (e) {
    // network hiccup, retry
  }
  setTimeout(pollTelegram, 1000);
}

// ─── TG 私聊 → 帖子墙发帖 ────────────────────────────────
function handleTGPostToWall(msg) {
  const text = msg.text || msg.caption || '';
  const hasPhoto = msg.photo && msg.photo.length > 0;
  if (!text && !hasPhoto) return;
  const author = (msg.from && (msg.from.username ? '@' + msg.from.username : msg.from.first_name)) || 'TG用户';
  // 管理员（焦羽本人）显示为"焦羽"
  const TG_ADMIN = 'fuck001';
  const authorName = (msg.from && msg.from.username === TG_ADMIN) ? '焦羽' : author;

  const doAdd = (image) => {
    addPost({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      text: text.trim(),
      image: image || '',
      author: authorName,
      tgMsgId: msg.message_id || null,
      time: new Date().toISOString()
    });
    const reply = {
      chat_id: msg.chat.id,
      text: '✅ 已发布到资源墙'
    };
    if (msg.message_thread_id) reply.message_thread_id = msg.message_thread_id;
    tgAPI('sendMessage', reply).catch(() => {});
    console.log('[posts] TG 发帖:', author, text.slice(0, 30));
  };

  if (hasPhoto) {
    const photo = msg.photo[msg.photo.length - 1];
    downloadTGFile(photo.file_id, POSTS_MEDIA_DIR).then(imgUrl => {
      if (imgUrl) doAdd(imgUrl);
      else console.error('[posts] TG 图片下载失败');
    });
    return;
  }
  doAdd('');
}

// ─── TG 会员话题 → 广播给网页端会员 ──────────────────────
function handleTGMemberMessage(msg) {
  const text = msg.text || msg.caption || '';
  const hasPhoto = msg.photo && msg.photo.length > 0;
  if (!text && !hasPhoto) return;
  const senderRaw = (msg.from && (msg.from.username ? '@' + msg.from.username : msg.from.first_name)) || '管理员';
  // 管理员（焦羽本人）显示为"焦羽"
  const sender = (msg.from && msg.from.username === 'fuck001') ? '焦羽' : senderRaw;
  const payload = (type, url) => ({
    id: 'tg-' + msg.message_id,
    memberId: 'tg',
    nick: sender,
    avatar: '📣',
    bg: '#f0f0f0',
    color: '#2563eb',
    text,
    type,
    url: url || '',
    time: Date.now()
  });

  if (hasPhoto) {
    const photo = msg.photo[msg.photo.length - 1];
    downloadTGFile(photo.file_id).then(imgUrl => {
      if (imgUrl) {
        const p = payload('image', imgUrl);
        memberNS.emit('member-message', p);
        appendMemberLog(p);
      } else {
        console.error('[member] TG 图片下载失败');
      }
    });
    return;
  }
  const p = payload('text', '');
  memberNS.emit('member-message', p);
  appendMemberLog(p);
}

function handleTGMessage(msg) {
  if (!msg) return;
  if (msg.from && msg.from.is_bot) return;

  // 私聊 → 帖子墙发帖（TG 跟我说通道）
  if (msg.chat && msg.chat.type === 'private') {
    handleTGPostToWall(msg);
    return;
  }

  if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
  if (!msg.message_thread_id) return;

  // 帖子墙壁话题 → 自动上墙（管理员发帖通道）
  if (POSTS_TOPIC_ID && String(msg.message_thread_id) === String(POSTS_TOPIC_ID)) {
    // 回复"删"指令：删除被回复的那条帖子
    const delText = (msg.text || '').trim();
    if (msg.reply_to_message && ['删', '删除', 'del', '/del', '删掉'].includes(delText.toLowerCase())) {
      const targetTgId = msg.reply_to_message.message_id;
      const posts = loadPosts();
      const idx = posts.findIndex(p => String(p.tgMsgId) === String(targetTgId));
      if (idx !== -1) {
        posts.splice(idx, 1);
        savePosts(posts);
        tgAPI('sendMessage', {
          chat_id: msg.chat.id,
          message_thread_id: msg.message_thread_id,
          text: '🗑️ 帖子已删除'
        }).catch(() => {});
        console.log('[posts] TG 删除帖子 tgMsgId=' + targetTgId);
      } else {
        tgAPI('sendMessage', {
          chat_id: msg.chat.id,
          message_thread_id: msg.message_thread_id,
          text: '⚠️ 没找到对应帖子（可能是旧帖子，没有记录 TG 消息 ID）'
        }).catch(() => {});
      }
      return;
    }
    handleTGPostToWall(msg);
    return;
  }

  // 会员群话题消息 → 广播给网页端会员
  if (MEMBER_TOPIC_ID && String(msg.message_thread_id) === String(MEMBER_TOPIC_ID)) {
    handleTGMemberMessage(msg);
    return;
  }

  // 未知话题：打日志（用于抓取新话题 ID）
  console.log('[TG] 未识别话题 chat=' + msg.chat.id + ' thread=' + msg.message_thread_id + ' text=' + (msg.text || msg.caption || '').slice(0, 30));

  const visitorId = topicVisitors.get(msg.message_thread_id);
  if (!visitorId) return;

  const text = msg.text || msg.caption || '';
  const hasPhoto = msg.photo && msg.photo.length > 0;
  if (!text && !hasPhoto) return;

  // Handle photo from Telegram
  if (hasPhoto) {
    const photo = msg.photo[msg.photo.length - 1];
    console.log('TG photo → visitor ' + visitorId);
    const vTopic = visitorTopics.get(visitorId);
    downloadTGFileWithRetry(photo.file_id).then(imgUrl => {
      if (!imgUrl) {
        console.error('Failed to download TG photo');
        return;
      }
      // Re-check visitor socket (may have reconnected during async download)
      const currentVs = io.sockets.sockets.get(visitorId);
      const entry = { from: 'admin', type: 'image', url: imgUrl, text: text || '', timestamp: new Date().toISOString() };
      if (currentVs) {
        currentVs.emit('admin-message', { text: text || '', type: 'image', url: imgUrl });
        if (vTopic && vTopic.legacyId) saveChatLog(vTopic.legacyId, entry);
      } else if (vTopic && vTopic.legacyId) {
        savePendingMessage(vTopic.legacyId, entry);
        tgAPI('sendMessage', {
          chat_id: TELEGRAM_CHAT_ID,
          message_thread_id: msg.message_thread_id,
          text: '📦 图片已缓存，上线后自动送达',
        }).catch(() => {});
        console.log('Saved pending photo for ' + vTopic.name);
      }
    });
    return;
  }

  console.log('TG reply → visitor ' + visitorId + ': ' + text);

  const vs = io.sockets.sockets.get(visitorId);
  const vTopic = visitorTopics.get(visitorId);
  const v = sessions.get(visitorId);
  if (vs) {
    vs.emit('admin-message', { text });
    // Save Telegram reply to chat log so it persists on refresh
    if (v && v.legacyId) {
      saveChatLog(v.legacyId, { from: 'admin', text, timestamp: new Date().toISOString() });
    }
  } else if (vTopic && vTopic.legacyId) {
    // Visitor offline - save as pending message using legacyId from topic mapping
    savePendingMessage(vTopic.legacyId, { text, timestamp: new Date().toISOString() });
    tgAPI('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: msg.message_thread_id,
      text: '📦 访客当前离线，消息已缓存，上线后自动送达',
    }).catch(() => {});
    console.log('Saved pending message for ' + vTopic.name + ' (legacyId=' + vTopic.legacyId + ')');
  } else {
    tgAPI('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: msg.message_thread_id,
      text: '⚠️ 该访客已离开，无法送达消息',
    }).catch(() => {});
  }
}

// ─── Start ────────────────────────────────────────────────────
// ─── Daily upload cleanup at midnight ──────────────────────
function scheduleDailyCleanup() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const ms = tomorrow - now;
  setTimeout(() => {
    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const f of files) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {}
      }
      console.log('Daily upload cleanup done at', new Date().toISOString(), '- removed', files.length, 'files');
    }
    scheduleDailyCleanup();
  }, ms);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Chat server running on http://localhost:' + PORT);
  console.log('Visitor page: http://localhost:' + PORT);
  console.log('Admin page: http://localhost:' + PORT + '/admin?pw=' + ADMIN_PASSWORD);
  console.log('Telegram Bot polling started (via proxy) ...');
  pollTelegram();
  scheduleDailyCleanup();
  console.log('Daily upload cleanup scheduled');
});
