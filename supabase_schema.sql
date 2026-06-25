-- ══════════════════════════════════════════════
--  شات نجمة وقمر — جداول Supabase
--  انسخ هذا الكود كاملاً في Supabase > SQL Editor
-- ══════════════════════════════════════════════

-- جدول المستخدمين
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  points      INTEGER DEFAULT 0,
  avatar      TEXT DEFAULT '🌟',
  color       TEXT DEFAULT '#ffff00',
  name_style  TEXT DEFAULT 'neon',
  last_seen   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- جدول الرسائل
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  room        TEXT NOT NULL DEFAULT 'general',
  user_name   TEXT NOT NULL,
  user_color  TEXT DEFAULT '#ffff00',
  user_style  TEXT DEFAULT 'neon',
  user_role   TEXT DEFAULT 'member',
  text        TEXT NOT NULL,
  is_media    BOOLEAN DEFAULT FALSE,
  deleted     BOOLEAN DEFAULT FALSE,
  deleted_by  TEXT,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- جدول الأصدقاء
CREATE TABLE IF NOT EXISTS friends (
  user_email    TEXT NOT NULL,
  friend_email  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_email, friend_email)
);

-- ══════════════════════════════════════════════
--  فهارس لتسريع الاستعلامات
-- ══════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_messages_room       ON messages (room, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_deleted    ON messages (deleted);
CREATE INDEX IF NOT EXISTS idx_friends_user_email  ON friends (user_email);

-- ══════════════════════════════════════════════
--  Row Level Security (RLS) — اتركه مفتوحاً
--  لأن السيرفر هو الوحيد الذي يتصل بـ Supabase
-- ══════════════════════════════════════════════
ALTER TABLE users    DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE friends  DISABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════
--  تنظيف تلقائي: احذف رسائل أقدم من 30 يوم
-- ══════════════════════════════════════════════
-- (اختياري — شغّله من Supabase > Database > Functions)
-- CREATE OR REPLACE FUNCTION delete_old_messages()
-- RETURNS void AS $$
-- BEGIN
--   DELETE FROM messages WHERE created_at < NOW() - INTERVAL '30 days';
-- END;
-- $$ LANGUAGE plpgsql;
