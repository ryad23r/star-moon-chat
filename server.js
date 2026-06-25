const express    = require('express');
const http       = require('http');
const socketIo   = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const server = http.createServer(app);

// ══════════════════════════════════════════
//  متغيرات البيئة  (Environment Variables)
// ══════════════════════════════════════════
const OWNER_EMAIL     = process.env.OWNER_EMAIL     || 'ka7laa2003@gmail.com';
const OWNER_SECRET    = process.env.OWNER_SECRET    || 'change_me_in_render';
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN  || '*';
const SUPABASE_URL    = process.env.SUPABASE_URL;      // مطلوب
const SUPABASE_KEY    = process.env.SUPABASE_KEY;      // مطلوب (anon key)

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ يجب إضافة SUPABASE_URL و SUPABASE_KEY في متغيرات البيئة!');
}

// ══════════════════════════════════════════
//  Supabase Client
// ══════════════════════════════════════════
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════
//  Socket.io
// ══════════════════════════════════════════
const io = socketIo(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6
});

// ══════════════════════════════════════════
//  Security Headers
// ══════════════════════════════════════════
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
app.use(express.static(__dirname));

// ══════════════════════════════════════════
//  Rate Limiting بسيط
// ══════════════════════════════════════════
const rateLimitMap = new Map();
function checkRateLimit(socketId, action, maxCount, windowMs) {
  const key = `${socketId}:${action}`;
  const now = Date.now();
  const rec = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > rec.resetAt) { rec.count = 1; rec.resetAt = now + windowMs; }
  else rec.count++;
  rateLimitMap.set(key, rec);
  if (rateLimitMap.size > 10000)
    for (const [k, v] of rateLimitMap) if (Date.now() > v.resetAt) rateLimitMap.delete(k);
  return rec.count <= maxCount;
}

// ══════════════════════════════════════════
//  ذاكرة مؤقتة (In-Memory)
// ══════════════════════════════════════════
const connectedUsers  = new Map();   // socket.id → user
const roomMessages    = { general: [], friends: [], vip: [], games: [] };
const privateMessages = new Map();
const friendRequests  = new Map();
const userFriends     = new Map();

// ══════════════════════════════════════════
//  دوال Supabase — المستخدمون
// ══════════════════════════════════════════
async function dbGetUser(email) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') console.error('dbGetUser:', error.message);
  return data || null;
}

async function dbUpsertUser(user) {
  const { error } = await supabase
    .from('users')
    .upsert({
      email:      user.email,
      name:       user.name,
      role:       user.role || 'member',
      points:     user.points || 0,
      avatar:     user.avatar || '🌟',
      color:      user.color || '#ffff00',
      name_style: user.nameStyle || 'neon',
      updated_at: new Date().toISOString()
    }, { onConflict: 'email' });
  if (error) console.error('dbUpsertUser:', error.message);
}

async function dbUpdateRole(email, role) {
  const { error } = await supabase
    .from('users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('email', email);
  if (error) console.error('dbUpdateRole:', error.message);
}

// ══════════════════════════════════════════
//  دوال Supabase — الرسائل
// ══════════════════════════════════════════
async function dbSaveMessage(msg) {
  const { error } = await supabase
    .from('messages')
    .insert({
      id:         msg.id,
      room:       msg.room,
      user_name:  msg.name,
      user_color: msg.color,
      user_style: msg.style,
      user_role:  msg.role,
      text:       msg.text,
      is_media:   msg.isMedia || false,
      deleted:    false,
      created_at: new Date(msg.timestamp).toISOString()
    });
  if (error) console.error('dbSaveMessage:', error.message);
}

async function dbLoadMessages(room, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('room', room)
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('dbLoadMessages:', error.message); return []; }
  return (data || []).reverse().map(r => ({
    id:        r.id,
    room:      r.room,
    name:      r.user_name,
    color:     r.user_color,
    style:     r.user_style,
    role:      r.user_role,
    text:      r.text,
    isMedia:   r.is_media,
    time:      new Date(r.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
    timestamp: new Date(r.created_at).getTime()
  }));
}

async function dbDeleteMessage(messageId, deleterName) {
  const { error } = await supabase
    .from('messages')
    .update({ deleted: true, deleted_by: deleterName, deleted_at: new Date().toISOString() })
    .eq('id', messageId);
  if (error) { console.error('dbDeleteMessage:', error.message); return false; }
  return true;
}

// ══════════════════════════════════════════
//  دوال Supabase — الأصدقاء
// ══════════════════════════════════════════
async function dbGetFriends(email) {
  const { data, error } = await supabase
    .from('friends')
    .select('friend_email')
    .eq('user_email', email);
  if (error) { console.error('dbGetFriends:', error.message); return []; }
  return (data || []).map(r => r.friend_email);
}

async function dbAddFriendship(email1, email2) {
  const { error } = await supabase
    .from('friends')
    .upsert([
      { user_email: email1, friend_email: email2 },
      { user_email: email2, friend_email: email1 }
    ], { onConflict: 'user_email,friend_email', ignoreDuplicates: true });
  if (error) console.error('dbAddFriendship:', error.message);
}

// ══════════════════════════════════════════
//  تحميل رسائل الغرف عند بدء التشغيل
// ══════════════════════════════════════════
async function initRoomMessages() {
  for (const room of Object.keys(roomMessages)) {
    roomMessages[room] = await dbLoadMessages(room, 50);
  }
  console.log('✅ تم تحميل رسائل الغرف من Supabase');
}

// ══════════════════════════════════════════
//  دوال مساعدة
// ══════════════════════════════════════════
function updateOnlineUsers() {
  const list = Array.from(connectedUsers.values())
    .filter(u => u.online)
    .map(u => ({
      id: u.id, name: u.name, avatar: u.avatar,
      role: u.role || 'member', color: u.color || '#ff0',
      nameStyle: u.nameStyle || 'neon',
      currentRoom: u.currentRoom || 'general', online: u.online
    }));
  io.emit('users:update', list);
}

function getRoomName(r) {
  return { general: 'العامة', friends: 'الأصدقاء', vip: 'VIP', games: 'الألعاب' }[r] || r;
}
function getRoleName(r) {
  return { owner: 'مالك', admin: 'مسؤول', moderator: 'مشرف', vip: 'VIP', member: 'عضو', visitor: 'زائر' }[r] || r;
}

function sanitizeText(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').slice(0, 1000);
}
function sanitizeName(n) {
  if (typeof n !== 'string') return 'مجهول';
  return n.replace(/[<>&"]/g, '').trim().slice(0, 30) || 'مجهول';
}

// ══════════════════════════════════════════
//  مسارات الويب
// ══════════════════════════════════════════
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', users: connectedUsers.size, uptime: process.uptime() }));

app.get('/stats', (req, res) => {
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>إحصائيات</title>
<style>body{font-family:Arial,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;text-align:center;padding:50px}
.container{max-width:800px;margin:0 auto;padding:30px;background:rgba(255,255,255,.05);border-radius:15px}
h1{color:#fbbf24}.btn{display:inline-block;padding:15px 30px;margin:20px;background:linear-gradient(45deg,#f59e0b,#d97706);color:#fff;text-decoration:none;border-radius:10px;font-weight:700}
.stats{display:flex;justify-content:space-around;margin:40px 0;flex-wrap:wrap;gap:10px}
.stat-box{padding:20px;background:rgba(255,255,255,.1);border-radius:10px}.stat-number{font-size:2em;color:#60a5fa}
.badge{display:inline-block;padding:4px 10px;border-radius:20px;background:#10b981;font-size:.8em;margin-right:5px}</style></head>
<body><div class="container"><h1>📊 شات نجمة وقمر</h1>
<span class="badge">✅ Supabase متصل</span>
<div class="stats">
<div class="stat-box"><div class="stat-number">${connectedUsers.size}</div><div>متصل الآن</div></div>
<div class="stat-box"><div class="stat-number">4</div><div>غرف</div></div>
</div><a href="/" class="btn">🚀 العودة للشات</a>
<div style="margin-top:40px;text-align:right"><h3>📝 الغرف:</h3>
${Object.entries(roomMessages).map(([r,m])=>`<div style="padding:10px;border-bottom:1px solid rgba(255,255,255,.1)"><strong>${getRoomName(r)}:</strong> ${m.length} رسالة في الذاكرة</div>`).join('')}
</div></div></body></html>`);
});

// ══════════════════════════════════════════
//  Socket.io Events
// ══════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('👤 متصل:', socket.id);
  let currentUser = null;

  // ─── الانضمام ──────────────────────────────────────────────────
  socket.on('user:join', async (userData) => {
    if (!userData || typeof userData !== 'object') return;

    const name      = sanitizeName(userData.name || 'زائر');
    const email     = typeof userData.email === 'string' ? userData.email.trim().toLowerCase().slice(0, 100) : '';
    const avatar    = typeof userData.avatar === 'string' ? userData.avatar.slice(0, 200) : '🌟';
    const color     = /^#[0-9a-fA-F]{3,6}$/.test(userData.color) ? userData.color : '#ffff00';
    const nameStyle = ['neon','normal','bold','shadow'].includes(userData.nameStyle) ? userData.nameStyle : 'neon';

    currentUser = {
      id: socket.id, name, email, avatar, color, nameStyle,
      role: 'member',
      online: true, lastSeen: new Date(), currentRoom: 'general'
    };

    // استعادة البيانات من Supabase
    if (email) {
      try {
        let dbUser = await dbGetUser(email);

        if (dbUser) {
          currentUser.role   = dbUser.role   || 'member';
          currentUser.points = dbUser.points  || 0;
          console.log(`🔁 ${name} (${currentUser.role})`);
        } else {
          await dbUpsertUser({ email, name, role: 'member', points: 0, avatar, color, nameStyle });
          console.log(`📝 جديد: ${name}`);
        }

        // ✅ التحقق من المالك بإيميل + كلمة سر
        if (email === OWNER_EMAIL) {
          const secret = typeof userData.ownerSecret === 'string' ? userData.ownerSecret : '';
          if (secret === OWNER_SECRET) {
            currentUser.role = 'owner';
            await dbUpdateRole(email, 'owner');
            socket.emit('user:promoted', { role: 'owner', message: 'أنت الآن مالك الشات! 👑' });
            console.log(`👑 ${name} دخل كمالك`);
          } else {
            console.log(`⚠️ إيميل المالك بكلمة سر خاطئة`);
          }
        }

        // تحميل الأصدقاء من Supabase وربطهم بالـ socket IDs الحالية
        const friendEmails = await dbGetFriends(email);
        if (friendEmails.length > 0) {
          const friendSocketIds = [];
          connectedUsers.forEach((u, sid) => {
            if (friendEmails.includes(u.email)) friendSocketIds.push(sid);
          });
          userFriends.set(socket.id, friendSocketIds);
          console.log(`🤝 ${name} لديه ${friendSocketIds.length}/${friendEmails.length} صديق متصل`);
        }

      } catch (err) {
        console.error('خطأ Supabase في user:join:', err.message);
      }
    }

    connectedUsers.set(socket.id, currentUser);
    socket.join('general');

    socket.emit('room:messages', { room: 'general', messages: roomMessages.general.slice(-50) });
    socket.emit('server:welcome', {
      message: `مرحباً ${name}!`,
      users: Array.from(connectedUsers.values()).filter(u => u.online),
      room: 'general'
    });
    socket.broadcast.emit('user:joined', { user: currentUser, message: `${name} انضم للشات` });
    updateOnlineUsers();
  });

  // ─── تبديل الغرفة ──────────────────────────────────────────────
  socket.on('room:switch', async (room) => {
    if (!currentUser) return;
    const valid = ['general','friends','vip','games'];
    if (!valid.includes(room)) return;

    if (currentUser.role === 'visitor' && room !== 'general') {
      socket.emit('room:error', { message: '⚠️ الزوار في الغرفة العامة فقط' }); return;
    }
    if (room === 'vip' && !['owner','admin','vip'].includes(currentUser.role)) {
      socket.emit('room:error', { message: '⚠️ تحتاج عضوية VIP' }); return;
    }

    socket.leave(currentUser.currentRoom);
    currentUser.currentRoom = room;
    socket.join(room);

    // إذا الغرفة فارغة في الذاكرة، احمل من Supabase
    if (roomMessages[room].length === 0) {
      roomMessages[room] = await dbLoadMessages(room, 50);
    }

    socket.emit('room:messages', { room, messages: roomMessages[room].slice(-50) });
    socket.emit('room:switched', { room, name: getRoomName(room) });
    console.log(`🚪 ${currentUser.name} → ${room}`);
  });

  // ─── إرسال رسالة ───────────────────────────────────────────────
  socket.on('message:send', async (messageData) => {
    if (!currentUser) return;
    if (!checkRateLimit(socket.id, 'message', 10, 5000)) {
      socket.emit('admin:muted', { message: '⚠️ ترسل رسائل بسرعة كبيرة، تمهّل' }); return;
    }
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    const valid = ['general','friends','vip','games'];
    const room = valid.includes(messageData.room) ? messageData.room : 'general';

    if (room === 'vip' && !['owner','admin','vip'].includes(user.role)) {
      socket.emit('room:error', { message: '⚠️ تحتاج عضوية VIP' }); return;
    }
    if (user.role === 'visitor' && room !== 'general') {
      socket.emit('room:error', { message: '⚠️ الزوار في الغرفة العامة فقط' }); return;
    }
    if (user.mutedUntil && user.mutedUntil > Date.now()) {
      const rem = Math.ceil((user.mutedUntil - Date.now()) / 1000);
      socket.emit('admin:muted', { message: `مكتوم لمدة ${rem} ثانية` }); return;
    }

    const text = sanitizeText(messageData.text);
    if (!text) return;

    const message = {
      id:        Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
      userId:    socket.id,
      name:      user.name,
      text,
      time:      new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      color:     user.color  || '#ff0',
      style:     user.nameStyle || 'neon',
      role:      user.role   || 'member',
      room,
      timestamp: Date.now(),
      isMedia:   messageData.isMedia === true
    };

    if (!roomMessages[room]) roomMessages[room] = [];
    roomMessages[room].push(message);
    if (roomMessages[room].length > 100) roomMessages[room] = roomMessages[room].slice(-100);

    io.to(room).emit('message:new', message);

    // حفظ في Supabase بشكل غير متزامن (لا يؤخر الرسالة)
    dbSaveMessage(message).catch(e => console.error('خطأ حفظ رسالة:', e.message));

    console.log(`💬 ${user.name}@${room}: ${text.substring(0, 30)}`);
  });

  // ─── حذف رسالة ─────────────────────────────────────────────────
  socket.on('admin:deleteMessage', async (data) => {
    const admin = connectedUsers.get(socket.id);
    if (!admin || !['owner','admin','moderator'].includes(admin.role)) {
      socket.emit('admin:error', { message: 'لا صلاحية' }); return;
    }
    const { messageId, room, deleter } = data;
    if (!room || !roomMessages[room]) { socket.emit('admin:error', { message: 'الغرفة غير موجودة' }); return; }

    const idx = roomMessages[room].findIndex(m => m.id === messageId);
    if (idx === -1) { socket.emit('admin:error', { message: 'الرسالة غير موجودة' }); return; }

    const msg        = roomMessages[room][idx];
    const safeDeleter = sanitizeName(deleter);
    msg.deleted  = true;
    msg.deleter  = safeDeleter;
    msg.deletedAt = new Date().toISOString();

    // حذف من Supabase
    await dbDeleteMessage(messageId, safeDeleter);

    io.to(room).emit('message:deleted', {
      messageId, deleter: safeDeleter, room,
      originalSender: msg.name, timestamp: msg.deletedAt
    });
    socket.emit('admin:success', { message: `تم حذف رسالة ${msg.name}` });
    io.to(room).emit('system:message', { message: `🗑️ ${safeDeleter} حذف رسالة`, type: 'warning' });
  });

  // ─── الإبلاغ ────────────────────────────────────────────────────
  socket.on('message:report', (data) => {
    const reporter = connectedUsers.get(socket.id);
    if (!reporter) return;
    const safeReason = sanitizeText(data.reason || '').slice(0, 200);
    connectedUsers.forEach((user, uid) => {
      if (['owner','admin','moderator'].includes(user.role)) {
        const s = io.sockets.sockets.get(uid);
        if (s) s.emit('admin:report', {
          messageId: data.messageId, reporterName: reporter.name,
          reason: safeReason, room: data.room, timestamp: new Date().toISOString()
        });
      }
    });
  });

  // ─── دردشة خاصة ────────────────────────────────────────────────
  socket.on('private:send', (data) => {
    const from = connectedUsers.get(socket.id);
    const to   = connectedUsers.get(data.to);
    if (!from || !to) { socket.emit('private:error', { message: 'المستخدم غير متصل' }); return; }
    if (from.role === 'visitor') { socket.emit('private:error', { message: '⚠️ الزوار لا يمكنهم إرسال رسائل خاصة' }); return; }
    if (!checkRateLimit(socket.id, 'private', 5, 5000)) { socket.emit('private:error', { message: '⚠️ ترسل بسرعة' }); return; }
    const text = sanitizeText(data.message);
    if (!text) return;

    const chatKey = [socket.id, data.to].sort().join('_');
    if (!privateMessages.has(chatKey)) privateMessages.set(chatKey, []);
    const msg = {
      id: Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
      from: socket.id, fromName: from.name, fromAvatar: from.avatar,
      to: data.to, toName: to.name, text,
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now(), read: false
    };
    privateMessages.get(chatKey).push(msg);
    socket.to(data.to).emit('private:message', msg);
    socket.emit('private:sent', msg);
  });

  socket.on('private:history', (data, cb) => {
    if (typeof cb !== 'function') return;
    const chatKey = [socket.id, data.with].sort().join('_');
    cb((privateMessages.get(chatKey) || []).slice(-50));
  });

  // ─── طلب صداقة ─────────────────────────────────────────────────
  socket.on('friend:request', (data) => {
    const from = connectedUsers.get(socket.id);
    const to   = connectedUsers.get(data.to);
    if (!from || !to) { socket.emit('friend:error', { message: 'المستخدم غير متصل' }); return; }
    if (from.role === 'visitor') { socket.emit('friend:error', { message: '⚠️ الزوار لا يمكنهم إرسال طلبات' }); return; }
    const existing = Array.from(friendRequests.values())
      .find(r => r.from === socket.id && r.to === data.to && r.status === 'pending');
    if (existing) { socket.emit('friend:error', { message: 'أرسلت طلب مسبقاً' }); return; }

    const reqId = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const req = {
      id: reqId, from: socket.id, fromName: from.name, fromAvatar: from.avatar,
      to: data.to, toName: to.name, status: 'pending', timestamp: Date.now()
    };
    friendRequests.set(reqId, req);
    socket.to(data.to).emit('friend:request', req);
    socket.emit('friend:sent', { message: 'تم إرسال طلب الصداقة' });
  });

  socket.on('friend:response', async (data) => {
    const req = friendRequests.get(data.requestId);
    if (!req || req.to !== socket.id) { socket.emit('friend:error', { message: 'الطلب غير موجود' }); return; }
    req.status = data.accept ? 'accepted' : 'rejected';

    if (data.accept) {
      if (!userFriends.has(req.from)) userFriends.set(req.from, []);
      if (!userFriends.get(req.from).includes(req.to)) userFriends.get(req.from).push(req.to);
      if (!userFriends.has(req.to)) userFriends.set(req.to, []);
      if (!userFriends.get(req.to).includes(req.from)) userFriends.get(req.to).push(req.from);

      // حفظ في Supabase
      const fromUser = connectedUsers.get(req.from);
      const toUser   = connectedUsers.get(req.to);
      if (fromUser?.email && toUser?.email) {
        await dbAddFriendship(fromUser.email, toUser.email);
      }

      io.to(req.from).emit('friend:accepted', { friendId: req.to, friendName: req.toName });
      socket.emit('friend:accepted', { friendId: req.from, friendName: req.fromName });
      if (fromUser && toUser) {
        io.to(req.from).emit('system:message', { message: `🎉 أنت و ${toUser.name} أصبحتما صديقين!`, type: 'success' });
        io.to(req.to).emit('system:message', { message: `🎉 أنت و ${fromUser.name} أصبحتما صديقين!`, type: 'success' });
      }
    } else {
      io.to(req.from).emit('friend:rejected', { friendName: req.toName });
    }
  });

  socket.on('friends:list', (cb) => {
    if (typeof cb !== 'function') return;
    const friends = userFriends.get(socket.id) || [];
    cb(friends.map(id => {
      const u = connectedUsers.get(id);
      return u ? { id: u.id, name: u.name, avatar: u.avatar, role: u.role, online: u.online } : null;
    }).filter(Boolean));
  });

  socket.on('friends:requests', (cb) => {
    if (typeof cb !== 'function') return;
    cb(Array.from(friendRequests.values()).filter(r => r.to === socket.id && r.status === 'pending'));
  });

  // ─── أوامر الإدارة ──────────────────────────────────────────────
  socket.on('admin:mute', (data) => {
    const admin  = connectedUsers.get(socket.id);
    const target = connectedUsers.get(data.userId);
    if (!admin || !target) return;
    if (!['owner','admin','moderator'].includes(admin.role)) { socket.emit('admin:error', { message: 'لا صلاحية' }); return; }
    if (target.role === 'owner' || (target.role === 'admin' && admin.role !== 'owner')) { socket.emit('admin:error', { message: 'لا يمكنك كتم هذا' }); return; }
    const dur = Math.min(Math.max(parseInt(data.duration) || 60, 1), 86400);
    target.mutedUntil = Date.now() + dur * 1000;
    io.to(data.userId).emit('admin:muted', { duration: dur, reason: sanitizeText(data.reason || ''), admin: admin.name });
    socket.emit('admin:success', { message: `تم كتم ${target.name}` });
    io.emit('system:message', { message: `🔇 تم كتم ${target.name}`, type: 'warning' });
  });

  socket.on('admin:ban', (data) => {
    const admin  = connectedUsers.get(socket.id);
    const target = connectedUsers.get(data.userId);
    if (!admin || !target) return;
    if (!['owner','admin'].includes(admin.role)) { socket.emit('admin:error', { message: 'لا صلاحية' }); return; }
    if (target.role === 'owner' || (target.role === 'admin' && admin.role !== 'owner')) { socket.emit('admin:error', { message: 'لا يمكنك حظر هذا' }); return; }
    target.banned = true;
    setTimeout(() => {
      const s = io.sockets.sockets.get(data.userId);
      if (s) { s.emit('admin:kicked', { reason: sanitizeText(data.reason || 'محظور') }); s.disconnect(); }
    }, 1000);
    socket.emit('admin:success', { message: `تم حظر ${target.name}` });
    io.emit('system:message', { message: `🚫 تم حظر ${target.name}`, type: 'error' });
  });

  socket.on('admin:kick', (data) => {
    const admin  = connectedUsers.get(socket.id);
    const target = connectedUsers.get(data.userId);
    if (!admin || !target) return;
    if (!['owner','admin','moderator'].includes(admin.role)) { socket.emit('admin:error', { message: 'لا صلاحية' }); return; }
    if (target.role === 'owner' || (target.role === 'admin' && admin.role !== 'owner')) { socket.emit('admin:error', { message: 'لا يمكنك طرد هذا' }); return; }
    const s = io.sockets.sockets.get(data.userId);
    if (s) { s.emit('admin:kicked', { reason: sanitizeText(data.reason || 'تم طردك') }); setTimeout(() => s.disconnect(), 1000); }
    socket.emit('admin:success', { message: `تم طرد ${target.name}` });
    io.emit('system:message', { message: `👢 تم طرد ${target.name}`, type: 'warning' });
  });

  socket.on('admin:promote', async (data) => {
    const admin  = connectedUsers.get(socket.id);
    const target = connectedUsers.get(data.userId);
    if (!admin || !target) return;
    if (!['owner','admin'].includes(admin.role)) { socket.emit('admin:error', { message: 'لا صلاحية' }); return; }
    const validRoles = ['admin','moderator','vip','member'];
    if (!validRoles.includes(data.role)) { socket.emit('admin:error', { message: 'رتبة غير صالحة' }); return; }
    if (data.role === 'admin' && admin.role !== 'owner') { socket.emit('admin:error', { message: 'فقط المالك يعيّن مسؤولين' }); return; }
    if (target.role === 'owner') { socket.emit('admin:error', { message: 'لا يمكن تغيير رتبة المالك' }); return; }

    const oldRole = target.role;
    target.role = data.role;

    // حفظ الرتبة في Supabase
    if (target.email) await dbUpdateRole(target.email, data.role);

    const s = io.sockets.sockets.get(data.userId);
    if (s) {
      s.emit('user:promoted', { role: data.role, promotedBy: admin.name, message: `تمت ترقيتك إلى ${getRoleName(data.role)}` });
      s.emit('user:data:updated', { role: data.role, name: target.name, color: target.color, nameStyle: target.nameStyle });
    }
    socket.emit('admin:success', { message: `تم ترقية ${target.name} إلى ${getRoleName(data.role)}` });
    updateOnlineUsers();
    io.emit('system:message', { message: `⭐ تم ترقية ${target.name} إلى ${getRoleName(data.role)}`, type: 'success' });
    console.log(`⭐ ${admin.name}: ${target.name} ${oldRole} → ${data.role}`);
  });

  // ─── قطع الاتصال ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.online = false;
      currentUser.lastSeen = new Date();
      connectedUsers.set(socket.id, currentUser);
      console.log('👤 انقطع:', currentUser.name);
      updateOnlineUsers();
      socket.broadcast.emit('user:left', {
        userId: socket.id, userName: currentUser.name,
        message: `${currentUser.name} غادر الشات`
      });
      // تحديث آخر ظهور في Supabase
      if (currentUser.email) {
        supabase.from('users').update({ last_seen: new Date().toISOString() })
          .eq('email', currentUser.email).then();
      }
    }
  });
});

// ══════════════════════════════════════════
//  تشغيل السيرفر
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;

initRoomMessages().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '═'.repeat(50));
    console.log(`🌙  شات نجمة وقمر v3 — المنفذ ${PORT}`);
    console.log(`🗄️  Supabase: ${SUPABASE_URL ? '✅ متصل' : '❌ غير مضبوط'}`);
    console.log(`🔗  http://localhost:${PORT}`);
    console.log('═'.repeat(50) + '\n');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`❌ المنفذ ${PORT} مستخدم`);
  else console.error('❌ خطأ:', err);
});

process.on('SIGTERM', () => {
  console.log('🛑 إيقاف نظيف...');
  server.close(() => process.exit(0));
});
