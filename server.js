const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const multer = require('multer');
const FormData = require('form-data');

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

// ─── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin888';
const DATA_DIR = path.join(__dirname, 'data');
const VISITORS_FILE = path.join(DATA_DIR, 'visitors.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

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
app.use('/uploads', express.static(UPLOADS_DIR));

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

// ─── Download Telegram file ───────────────────────────────
async function downloadTGFile(fileId) {
  const info = await tgAPI('getFile', { file_id: fileId });
  if (!info.ok || !info.result) {
    console.error('downloadTGFile: getFile failed', info);
    return null;
  }
  const filePath = info.result.file_path;
  const ext = path.extname(filePath) || '.jpg';
  const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  const savePath = path.join(UPLOADS_DIR, filename);
  // Ensure uploads directory exists
  try { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch(e) {}
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
        file.close(() => {
          const size = fs.statSync(savePath).size;
          console.log('downloadTGFile: saved', filename, size + ' bytes');
          resolve('/uploads/' + filename);
        });
      });
    }).on('error', (err) => {
      console.error('downloadTGFile: connection error', err.message);
      try { fs.unlinkSync(savePath); } catch {}
      resolve(null);
    });
  });
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
          socket.emit('admin-message', { text: pm.text });
          // Save to chat log so pending messages persist on future refresh
          saveChatLog(visitor.legacyId, {
            from: 'admin',
            text: pm.text,
            timestamp: pm.timestamp || new Date().toISOString()
          });
        }
        clearPendingMessages(visitor.legacyId);
        console.log('Delivered ' + pending.length + ' pending messages to ' + visitor.name);
      }
    }

    // 创建 TG 话题
    createTopicForVisitor(visitor, socket.id);

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
              await tgSendPhoto(TELEGRAM_CHAT_ID, topic.topicId, imgPath, text || '');
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

// ─── Create/Reuse Telegram Forum Topic ───────────────────────
const cookieTopics = loadCookieTopics();

async function createTopicForVisitor(visitor, socketId) {
  const legacyId = visitor.legacyId;

  // Already has a persistent topic for this cookie
  if (legacyId && cookieTopics[legacyId]) {
    const topicId = cookieTopics[legacyId];
    visitorTopics.set(socketId, { topicId, name: visitor.name, legacyId: visitor.legacyId });
    topicVisitors.set(topicId, socketId);

    tgAPI('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: topicId,
      text: `🟢 ${visitor.name} 重新上线`,
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
      text: `🟢 ${visitor.name} 加入了对话`,
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

function handleTGMessage(msg) {
  if (!msg) return;
  if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
  if (msg.from && msg.from.is_bot) return;
  if (!msg.message_thread_id) return;

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
    downloadTGFile(photo.file_id).then(imgUrl => {
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
