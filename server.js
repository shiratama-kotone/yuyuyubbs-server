// server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const requestTimestamps = {};

// ----------------------
// WebSocket ブロードキャスト
// ----------------------
// channel: 'chat' | 'battle'
function broadcast(channel, data) {
  const msg = JSON.stringify({ channel, ...data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
  // Webhookへ送信（投稿イベントのみ）
  if (data.type === "post" && data.post) {
    const post = data.post;
    const payload = {
      event_time: new Date().toISOString(),
      id:         post.id,
      name:       post.name,
      no:         post.no,
      content:    post.content,
      role:       post.role ?? 0,
      channel,
    };
    pool.query(`SELECT url FROM webhooks WHERE channel=$1`, [channel]).then(({ rows }) => {
      rows.forEach(({ url }) => {
        axios.post(url, payload, { timeout: 5000 }).catch(() => {});
      });
    }).catch(() => {});
  }
}

wss.on("connection", (ws) => {
  ws.on("error", console.error);
});

// ----------------------
// DB初期化
// ----------------------
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        no SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        id TEXT NOT NULL,
        time TEXT NOT NULL,
        deleted BOOLEAN DEFAULT FALSE
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS battle_posts (
        no SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        id TEXT NOT NULL,
        time TEXT NOT NULL,
        deleted BOOLEAN DEFAULT FALSE
      )
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS admin   (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS summit  (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS manager (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS speaker (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS color (id TEXT PRIMARY KEY, color_code TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS "add" (id TEXT PRIMARY KEY, suffix TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await client.query(`
      INSERT INTO settings (key, value) VALUES
        ('topic',          '掲示板'),
        ('battle_topic',   'バトルスタジアム'),
        ('prevent',        'false'),
        ('restrict',       'false'),
        ('stop_until',     '0'),
        ('prohibit_until', '0')
      ON CONFLICT (key) DO NOTHING
    `);
    await client.query(`CREATE TABLE IF NOT EXISTS ng_words  (word TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ban       (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS kill_list (id TEXT PRIMARY KEY)`);

    // アカウント・Webhookテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        username    TEXT PRIMARY KEY,
        bbs_id      TEXT NOT NULL,
        token       TEXT NOT NULL UNIQUE,
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id          SERIAL PRIMARY KEY,
        username    TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
        url         TEXT NOT NULL,
        channel     TEXT NOT NULL DEFAULT 'chat',
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `);
    // 地雷テーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS mines (
        id          SERIAL PRIMARY KEY,
        word        TEXT NOT NULL,
        channel     TEXT NOT NULL DEFAULT 'chat',
        created_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

    // 雑談シード投稿
    await client.query(`
      INSERT INTO posts (no, name, id, content, time) VALUES
        (0, 'さーばー', '( ᐛ )', 'ぜんけしー',   '0001/01/01 00:00'),
        (1, '学生',     '',        'どかーん',     '2011/7/3 0:0'),
        (2, 'ゆゆゆ',   '@42d3e89', '(think)',     '2011/12/26 0:0')
      ON CONFLICT (no) DO NOTHING
    `);
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('posts','no'),
        GREATEST(2, (SELECT MAX(no) FROM posts)),
        true
      )
    `);

    // 起動通知（雑談のみ）
    const bootTime = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    await client.query(
      `INSERT INTO posts (name, id, content, time) VALUES ('さーばー', '( ᐛ )', 'サーバーが再起動しました', $1)`,
      [bootTime]
    );

    console.log("DBを初期化しました");
  } finally {
    client.release();
  }
}
initDB().catch(console.error);

// ----------------------
// ヘルパー
// ----------------------
async function getRole(hashedId) {
  const { rows: a }  = await pool.query(`SELECT 1 FROM admin   WHERE id=$1`, [hashedId]);
  if (a.length)  return 4;
  const { rows: s }  = await pool.query(`SELECT 1 FROM summit  WHERE id=$1`, [hashedId]);
  if (s.length)  return 3;
  const { rows: m }  = await pool.query(`SELECT 1 FROM manager WHERE id=$1`, [hashedId]);
  if (m.length)  return 2;
  const { rows: sp } = await pool.query(`SELECT 1 FROM speaker WHERE id=$1`, [hashedId]);
  if (sp.length) return 1;
  return 0;
}

async function getSetting(key) {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`,
    [key, value]
  );
}

async function getRestrictionStatus() {
  const prevent       = await getSetting("prevent");
  const restrict      = await getSetting("restrict");
  const stopUntil     = parseInt(await getSetting("stop_until")     ?? "0");
  const prohibitUntil = parseInt(await getSetting("prohibit_until") ?? "0");
  const now = Date.now();
  return {
    prevent:        prevent === "true",
    restrict:       restrict === "true",
    stopActive:     now < stopUntil,
    stopUntil,
    prohibitActive: now < prohibitUntil,
    prohibitUntil,
  };
}

async function enrichPosts(posts) {
  return Promise.all(posts.map(async (p) => {
    const role = await getRole(p.id);
    const { rows: colorRows } = await pool.query(`SELECT color_code FROM color WHERE id=$1`, [p.id]);
    const { rows: addRows }   = await pool.query(`SELECT suffix FROM "add" WHERE id=$1`, [p.id]);
    return {
      ...p,
      role,
      colorCode: colorRows[0]?.color_code ?? null,
      addSuffix: addRows[0]?.suffix ?? null,
    };
  }));
}

async function pruneIfNeeded(table) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS cnt FROM ${table}`);
  if (parseInt(rows[0].cnt) >= 1000) {
    await pool.query(`DELETE FROM ${table} WHERE no > 2`);
  }
}

// ----------------------
// ヘルスチェック
// ----------------------
app.get("/",       (req, res) => res.send("掲示板サーバーが正常に動作しています"));
app.get("/health", (req, res) => res.status(200).json({ status: "OK", timestamp: new Date().toISOString() }));

// ----------------------
// 共通GET（ページネーション・差分取得対応）
// ----------------------
async function handleGet(table, topicKey, res, req) {
  try {
    const limit  = Math.min(parseInt(req.query.limit  ?? "50"), 200); // 最大200件
    const after  = parseInt(req.query.after  ?? "0");   // このno以降（差分取得）
    const before = parseInt(req.query.before ?? "0");   // このnoより前（ページング）

    // topic・restriction・件数を並列取得
    const [topicResult, rsResult, countResult] = await Promise.all([
      getSetting(topicKey),
      getRestrictionStatus(),
      pool.query(`SELECT COUNT(*) AS cnt FROM ${table}`),
    ]);

    let query, params;
    if (after > 0) {
      // 差分取得: afterより大きいnoの新着のみ
      query  = `SELECT * FROM ${table} WHERE no > $1 ORDER BY no DESC LIMIT $2`;
      params = [after, limit];
    } else if (before > 0) {
      // ページング: beforeより小さいnoを取得
      query  = `SELECT * FROM ${table} WHERE no < $1 ORDER BY no DESC LIMIT $2`;
      params = [before, limit];
    } else {
      // 初回取得
      query  = `SELECT * FROM ${table} ORDER BY no DESC LIMIT $1`;
      params = [limit];
    }

    const { rows: posts } = await pool.query(query, params);

    // enrichを並列化（color・addを一括JOIN）
    const enriched = await Promise.all(posts.map(async (p) => {
      const [roleVal, colorResult, addResult] = await Promise.all([
        getRole(p.id),
        pool.query(`SELECT color_code FROM color WHERE id=$1`, [p.id]),
        pool.query(`SELECT suffix FROM "add" WHERE id=$1`, [p.id]),
      ]);
      return {
        ...p,
        role:      roleVal,
        colorCode: colorResult.rows[0]?.color_code ?? null,
        addSuffix: addResult.rows[0]?.suffix ?? null,
      };
    }));

    res.json({
      topic:       topicResult,
      posts:       enriched,
      restriction: rsResult,
      total:       parseInt(countResult.rows[0].cnt),
      hasMore:     before > 0 ? enriched.length === limit : false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "データ読み込み失敗" });
  }
}

// ----------------------
// 共通POST
// ----------------------
async function handlePost(table, topicKey, channel, req, res) {
  const { name, pass, content } = req.query.name ? req.query : req.body;
  if (!name || !pass || !content)
    return res.status(400).json({ error: "全フィールド必須" });

  const now = Date.now();
  if (requestTimestamps[pass] && now - requestTimestamps[pass] < 1000)
    return res.status(429).json({ error: "同じパスワードで1秒に1回まで" });

  const hashedId = "@" + crypto.createHash("sha256").update(pass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);

  try {
    const role = await getRole(hashedId);

    const { rows: killRows } = await pool.query(`SELECT 1 FROM kill_list WHERE id=$1`, [hashedId]);
    if (killRows.length)
      return res.status(403).json({ error: "このアカウントは使用停止中です" });

    let commandMessage = null;

    // /clear
    if (content.trim() === "/clear") {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      await pool.query(`DELETE FROM ${table} WHERE no > 2`);
      await pool.query(`
        INSERT INTO posts (no, name, id, content, time) VALUES
          (0, 'さーばー', '( ᐛ )', 'ぜんけしー',   '0001/01/01 00:00'),
          (1, '学生',     '',        'どかーん',     '2011/7/3 0:0'),
          (2, 'ゆゆゆ',   '@42d3e89', '(think)',     '2011/12/26 0:0')
        ON CONFLICT (no) DO NOTHING
      `);
      await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','no'), 2, true)`);
      broadcast(channel, { type: "clear" });
      commandMessage = "/clear";
    }

    // /del
    const delMatch = !commandMessage && content.match(/^\/del\s+([\d\s]+)$/);
    if (delMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const nos = delMatch[1].trim().split(/\s+/).map(Number);
      for (const no of nos) {
        await pool.query(
          `UPDATE ${table} SET name='削除されました', content='削除されました', id='', deleted=TRUE WHERE no=$1`,
          [no]
        );
      }
      broadcast(channel, { type: "delete", nos });
      commandMessage = "/del";
    }

    // /destroy
    const destroyMatch = !commandMessage && content.match(/^\/destroy\s+(.+)$/);
    if (destroyMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const targets = destroyMatch[1].trim().split(/\s+/);
      const colorMap = { blue: 0, darkorange: 1, red: 2, darkcyan: 3 };
      for (const target of targets) {
        if (colorMap[target] !== undefined) {
          // 権限色で削除
          const tableMap = { 1: "speaker", 2: "manager", 3: "summit" };
          let ids = [];
          if (colorMap[target] === 0) {
            const { rows: allIds } = await pool.query(`SELECT DISTINCT id FROM ${table} WHERE id != ''`);
            for (const row of allIds) {
              if ((await getRole(row.id)) === 0) ids.push(row.id);
            }
          } else {
            const { rows } = await pool.query(`SELECT id FROM ${tableMap[colorMap[target]]}`);
            ids = rows.map(r => r.id);
          }
          for (const id of ids) {
            await pool.query(
              `UPDATE ${table} SET name='削除されました', content='削除されました', id='', deleted=TRUE WHERE id=$1`,
              [id]
            );
          }
        } else {
          // 文字列・ID・名前の部分一致で削除
          await pool.query(
            `UPDATE ${table} SET name='削除されました', content='削除されました', id='', deleted=TRUE
             WHERE content LIKE $1 OR id=$2 OR name LIKE $1`,
            [`%${target}%`, target]
          );
        }
      }
      broadcast(channel, { type: "destroy" });
      commandMessage = "/destroy";
    }

    // /topic（複数行・最大10行）
    const topicMatch = !commandMessage && content.match(/^\/topic(?:\s+|\n)([\s\S]+)$/);
    if (topicMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const lines = topicMatch[1].split('\n').slice(0, 10);
      await setSetting(topicKey, lines.join('\n').trim());
      commandMessage = "/topic";
    }

    // /NG
    const ngMatch = !commandMessage && content.match(/^\/NG\s+(.+)$/);
    if (ngMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      for (const word of ngMatch[1].trim().split(/\s+/))
        await pool.query(`INSERT INTO ng_words (word) VALUES ($1) ON CONFLICT DO NOTHING`, [word]);
      commandMessage = "/NG";
    }

    // /OK
    const okMatch = !commandMessage && content.match(/^\/OK\s+(.+)$/);
    if (okMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      for (const word of okMatch[1].trim().split(/\s+/))
        await pool.query(`DELETE FROM ng_words WHERE word=$1`, [word]);
      commandMessage = "/OK";
    }

    // /prevent
    if (!commandMessage && content.trim() === "/prevent") {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      await setSetting("prevent", "true");
      commandMessage = "/prevent";
    }

    // /permit
    if (!commandMessage && content.trim() === "/permit") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await setSetting("prevent", "false");
      commandMessage = "/permit";
    }

    // /restrict
    if (!commandMessage && content.trim() === "/restrict") {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      await setSetting("restrict", "true");
      commandMessage = "/restrict";
    }

    // /stop
    if (!commandMessage && content.trim() === "/stop") {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      await setSetting("stop_until", String(Date.now() + 3 * 60 * 1000));
      commandMessage = "/stop";
    }

    // /prohibit
    const prohibitMatch = !commandMessage && content.match(/^\/prohibit\s+(\d+h)?(\d+m)?$/i);
    if (prohibitMatch && (prohibitMatch[1] || prohibitMatch[2])) {
      if (role < 4) return res.status(403).json({ error: "権限不足 (運営のみ)" });
      const hours   = prohibitMatch[1] ? parseInt(prohibitMatch[1]) : 0;
      const minutes = prohibitMatch[2] ? parseInt(prohibitMatch[2]) : 0;
      await setSetting("prohibit_until", String(Date.now() + (hours * 60 + minutes) * 60 * 1000));
      commandMessage = "/prohibit";
    }

    // /release
    if (!commandMessage && content.trim() === "/release") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await setSetting("restrict",       "false");
      await setSetting("stop_until",     "0");
      await setSetting("prohibit_until", "0");
      commandMessage = "/release";
    }

    // /speaker /manager /summit
    const promoteMatch = !commandMessage && content.match(/^\/(speaker|manager|summit)\s+(.+)$/i);
    if (promoteMatch) {
      const cmd = promoteMatch[1].toLowerCase();
      const targets = promoteMatch[2].trim().split(/\s+/);
      const grantLevel = { speaker: 1, manager: 2, summit: 3 }[cmd];
      const maxGrant   = role === 4 ? 3 : role === 3 ? 2 : role === 2 ? 1 : 0;
      if (role < 2 || grantLevel > maxGrant) return res.status(403).json({ error: "権限不足" });
      const tableMap = { 1: "speaker", 2: "manager", 3: "summit" };
      for (const targetId of targets) {
        const tid = targetId.startsWith("@") ? targetId : "@" + targetId;
        await pool.query(`INSERT INTO ${tableMap[grantLevel]} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
        for (let l = 1; l < grantLevel; l++)
          await pool.query(`DELETE FROM ${tableMap[l]} WHERE id=$1`, [tid]);
      }
      commandMessage = `/${cmd}`;
    }

    // /disspeaker /dismanager /dissummit /disself
    const demoteMatch = !commandMessage && content.match(/^\/(dis(?:speaker|manager|summit)|disself)\s*(.*)$/i);
    if (demoteMatch) {
      const cmd = demoteMatch[1].toLowerCase();
      if (cmd === "disself") {
        await pool.query(`DELETE FROM speaker WHERE id=$1`, [hashedId]);
        await pool.query(`DELETE FROM manager WHERE id=$1`, [hashedId]);
        await pool.query(`DELETE FROM summit  WHERE id=$1`, [hashedId]);
        commandMessage = "/disself";
      } else {
        const targets = demoteMatch[2].trim().split(/\s+/).filter(Boolean);
        if (!targets.length) return res.status(400).json({ error: "ID指定必須" });
        const demoteCmd  = cmd.replace("dis", "");
        const demoteTo   = { speaker: 0, manager: 1, summit: 2 }[demoteCmd];
        const demoteFrom = { speaker: 1, manager: 2, summit: 3 }[demoteCmd];
        const maxDemote  = role === 4 ? 3 : role === 3 ? 2 : role === 2 ? 1 : 0;
        if (role < 2 || demoteFrom > maxDemote) return res.status(403).json({ error: "権限不足" });
        const tableMap = { 1: "speaker", 2: "manager", 3: "summit" };
        for (const targetId of targets) {
          const tid = targetId.startsWith("@") ? targetId : "@" + targetId;
          await pool.query(`DELETE FROM speaker WHERE id=$1`, [tid]);
          await pool.query(`DELETE FROM manager WHERE id=$1`, [tid]);
          await pool.query(`DELETE FROM summit  WHERE id=$1`, [tid]);
          if (demoteTo === 1) await pool.query(`INSERT INTO speaker (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
          if (demoteTo === 2) await pool.query(`INSERT INTO manager (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
        }
        commandMessage = `/${cmd}`;
      }
    }

    // /kill
    const killMatch = !commandMessage && content.match(/^\/kill\s+(.+)$/);
    if (killMatch) {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      for (const t of killMatch[1].trim().split(/\s+/)) {
        const tid = t.startsWith("@") ? t : "@" + t;
        await pool.query(`INSERT INTO kill_list (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
      }
      commandMessage = "/kill";
    }

    // /ban
    const banMatch = !commandMessage && content.match(/^\/ban\s+(.+)$/);
    if (banMatch) {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      for (const t of banMatch[1].trim().split(/\s+/)) {
        if (/^\d+$/.test(t)) {
          const { rows } = await pool.query(`SELECT id FROM ${table} WHERE no=$1`, [parseInt(t)]);
          if (rows[0]?.id) await pool.query(`INSERT INTO ban (id) VALUES ($1) ON CONFLICT DO NOTHING`, [rows[0].id]);
        } else {
          const tid = t.startsWith("@") ? t : "@" + t;
          await pool.query(`INSERT INTO ban (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
        }
      }
      commandMessage = "/ban";
    }

    // /revive
    if (!commandMessage && content.trim() === "/revive") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await pool.query(`DELETE FROM kill_list`);
      await pool.query(`DELETE FROM ban`);
      commandMessage = "/revive";
    }

    // /add
    const addMatch = !commandMessage && content.match(/^\/add\s+(\S+)\s+(.+)$/);
    if (addMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const tid = addMatch[1].startsWith("@") ? addMatch[1] : "@" + addMatch[1];
      await pool.query(
        `INSERT INTO "add" (id, suffix) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET suffix=$2`,
        [tid, addMatch[2].trim()]
      );
      commandMessage = "/add";
    }

    // /color
    const colorMatch = !commandMessage && content.match(/^\/color\s+(#[0-9a-fA-F]{3,6})\s+(\S+)$/);
    if (colorMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const tid = colorMatch[2].startsWith("@") ? colorMatch[2] : "@" + colorMatch[2];
      await pool.query(
        `INSERT INTO color (id, color_code) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET color_code=$2`,
        [tid, colorMatch[1]]
      );
      commandMessage = "/color";
    }

    // /instances
    if (!commandMessage && content.trim() === "/instances") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const { rows } = await pool.query(`SELECT value FROM settings WHERE key='instances'`);
      commandMessage = "/instances";
    }
    const instancesMatch = !commandMessage && content.match(/^\/instances\s+(.+)$/);
    if (instancesMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await setSetting("instances", instancesMatch[1].trim());
      commandMessage = "/instances";
    }

    // /seedsearch
    if (!commandMessage && content.trim() === "/seedsearch") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const count = role >= 4 ? 200 : role >= 3 ? 100 : 10;
      const seeds = [];
      for (let i = 0; i < count; i++) {
        const seedPass = crypto.randomBytes(4).toString("hex");
        const seedId = "@" + crypto.createHash("sha256").update(seedPass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);
        seeds.push({ pass: seedPass, id: seedId });
      }
      requestTimestamps[pass] = now;
      return res.status(200).json({ message: "/seedsearch", seeds });
    }

    // /mine 言葉 — 地雷設置
    const mineMatch = !commandMessage && content.match(/^\/mine\s+(.+)$/);
    if (mineMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const word = mineMatch[1].trim();
      await pool.query(
        `INSERT INTO mines (word, channel, created_by) VALUES ($1, $2, $3)`,
        [word, channel, hashedId]
      );
      commandMessage = "/mine";
    }

    // /mineoff 言葉 — 地雷解除
    const mineoffMatch = !commandMessage && content.match(/^\/mineoff\s+(.+)$/);
    if (mineoffMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await pool.query(`DELETE FROM mines WHERE word=$1 AND channel=$2`, [mineoffMatch[1].trim(), channel]);
      commandMessage = "/mineoff";
    }

    // /mines — 地雷一覧
    if (!commandMessage && content.trim() === "/mines") {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const { rows: mineList } = await pool.query(`SELECT word FROM mines WHERE channel=$1`, [channel]);
      requestTimestamps[pass] = now;
      return res.status(200).json({ message: "/mines", mines: mineList.map(m => m.word) });
    }

    // =====================
    // 通常投稿
    // =====================
    if (!commandMessage && role === 0) {
      const rs = await getRestrictionStatus();
      if (table === "posts" && rs.prevent)
        return res.status(403).json({ error: "現在青IDは投稿できません (/prevent中)" });
      if (rs.stopActive)
        return res.status(403).json({ error: "現在青IDは投稿できません (/stop中)" });
      if (rs.prohibitActive)
        return res.status(403).json({ error: "現在青IDは投稿できません (/prohibit中)" });
      if (rs.restrict) {
        const { rows: banRows } = await pool.query(`SELECT 1 FROM ban WHERE id=$1`, [hashedId]);
        if (banRows.length)
          return res.status(403).json({ error: "投稿が禁止されています" });
      }
      const { rows: ngWords } = await pool.query(`SELECT word FROM ng_words`);
      for (const { word } of ngWords) {
        if (content.includes(word))
          return res.status(403).json({ error: `NGワード「${word}」が含まれています` });
      }
    }

    await pruneIfNeeded(table);

    const time = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const { rows: inserted } = await pool.query(
      `INSERT INTO ${table} (name, content, id, time) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, content, hashedId, time]
    );

    const enrichedPost = (await enrichPosts([inserted[0]]))[0];
    broadcast(channel, { type: "post", post: enrichedPost });

    // 地雷チェック（通常投稿のみ・0.05%の確率）
    if (!commandMessage && Math.random() < 0.0005) {
      const mineTime = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      const { rows: minePost } = await pool.query(
        `INSERT INTO ${table} (name, content, id, time) VALUES ('さーばー', $1, '( ᐛ )', $2) RETURNING *`,
        [`>>${inserted[0].no} 地雷踏んじゃったね…`, mineTime]
      );
      const enrichedMine = (await enrichPosts([minePost[0]]))[0];
      broadcast(channel, { type: "post", post: enrichedMine });
    }

    requestTimestamps[pass] = now;
    res.status(200).json({
      message: commandMessage ?? "投稿成功",
      post: inserted[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "データ処理失敗" });
  }
}

// ----------------------
// API エンドポイント
// ----------------------
app.get( "/api",         (req, res) => handleGet("posts",        "topic",        res, req));
app.post("/api",         (req, res) => handlePost("posts",       "topic",        "chat",   req, res));
app.get( "/api/battle",  (req, res) => handleGet("battle_posts", "battle_topic", res, req));
app.post("/api/battle",  (req, res) => handlePost("battle_posts","battle_topic", "battle", req, res));

app.post("/topic", async (req, res) => {
  const { topic, adminPassword } = req.body;
  if (!topic) return res.status(400).json({ error: "トピック入力必須" });
  if (adminPassword !== ADMIN_PASSWORD) return res.status(403).json({ error: "パスワード不正" });
  await setSetting("topic", topic);
  res.status(200).json({ message: "トピック更新完了" });
});

app.post("/delete", async (req, res) => {
  const { postNumber, adminPassword } = req.body;
  if (!postNumber || adminPassword !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "パスワード不正か投稿番号未指定" });
  await pool.query(
    `UPDATE posts SET name='削除されました', content='削除されました', id='', deleted=TRUE WHERE no=$1`,
    [parseInt(postNumber)]
  );
  res.status(200).json({ message: "投稿削除完了" });
});

app.get("/id", async (req, res) => {
  const { rows } = await pool.query(`SELECT id FROM admin`);
  res.json(rows.map(r => r.id));
});

// ----------------------
// 統計・ステータスAPI
// ----------------------

// サーバー統計
app.get("/stats", async (req, res) => {
  try {
    const [chatCount, battleCount, onlineCount, ngCount] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM posts WHERE deleted=FALSE`),
      pool.query(`SELECT COUNT(*) AS cnt FROM battle_posts WHERE deleted=FALSE`),
      pool.query(`SELECT COUNT(*) AS cnt FROM accounts`),
      pool.query(`SELECT COUNT(*) AS cnt FROM ng_words`),
    ]);
    const [adminCount, summitCount, managerCount, speakerCount] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM admin`),
      pool.query(`SELECT COUNT(*) AS cnt FROM summit`),
      pool.query(`SELECT COUNT(*) AS cnt FROM manager`),
      pool.query(`SELECT COUNT(*) AS cnt FROM speaker`),
    ]);
    res.json({
      posts: {
        chat:   parseInt(chatCount.rows[0].cnt),
        battle: parseInt(battleCount.rows[0].cnt),
      },
      accounts: parseInt(onlineCount.rows[0].cnt),
      ng_words: parseInt(ngCount.rows[0].cnt),
      roles: {
        admin:   parseInt(adminCount.rows[0].cnt),
        summit:  parseInt(summitCount.rows[0].cnt),
        manager: parseInt(managerCount.rows[0].cnt),
        speaker: parseInt(speakerCount.rows[0].cnt),
      },
      ws_connections: wss.clients.size,
      uptime_seconds: Math.floor(process.uptime()),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 投稿者ランキング（上位10件）
app.get("/stats/top-posters", async (req, res) => {
  try {
    const ch = req.query.channel === "battle" ? "battle_posts" : "posts";
    const { rows } = await pool.query(`
      SELECT id, COUNT(*) AS post_count
      FROM ${ch}
      WHERE deleted=FALSE AND id != '' AND id != '( ᐛ )' AND id != '@EQALERT'
      GROUP BY id ORDER BY post_count DESC LIMIT 10
    `);
    const enriched = await Promise.all(rows.map(async r => ({
      id:         r.id,
      role:       await getRole(r.id),
      post_count: parseInt(r.post_count),
    })));
    res.json({ ranking: enriched });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 規制状態
app.get("/status", async (req, res) => {
  try {
    const [rs, topic, battleTopic, ngWords, banCount, killCount] = await Promise.all([
      getRestrictionStatus(),
      getSetting("topic"),
      getSetting("battle_topic"),
      pool.query(`SELECT word FROM ng_words`),
      pool.query(`SELECT COUNT(*) AS cnt FROM ban`),
      pool.query(`SELECT COUNT(*) AS cnt FROM kill_list`),
    ]);
    res.json({
      restriction: rs,
      topics: { chat: topic, battle: battleTopic },
      ng_words:   ngWords.rows.map(r => r.word),
      ban_count:  parseInt(banCount.rows[0].cnt),
      kill_count: parseInt(killCount.rows[0].cnt),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// IDの情報を取得
app.get("/user/:id", async (req, res) => {
  try {
    const id = req.params.id.startsWith("@") ? req.params.id : "@" + req.params.id;
    const role = await getRole(id);
    const [colorResult, addResult, postCount] = await Promise.all([
      pool.query(`SELECT color_code FROM color WHERE id=$1`, [id]),
      pool.query(`SELECT suffix FROM "add" WHERE id=$1`, [id]),
      pool.query(`SELECT COUNT(*) AS cnt FROM posts WHERE id=$1 AND deleted=FALSE`, [id]),
    ]);
    const [isBanned, isKilled] = await Promise.all([
      pool.query(`SELECT 1 FROM ban WHERE id=$1`, [id]),
      pool.query(`SELECT 1 FROM kill_list WHERE id=$1`, [id]),
    ]);
    res.json({
      id,
      role,
      colorCode:  colorResult.rows[0]?.color_code ?? null,
      addSuffix:  addResult.rows[0]?.suffix ?? null,
      post_count: parseInt(postCount.rows[0].cnt),
      is_banned:  isBanned.rows.length > 0,
      is_killed:  isKilled.rows.length > 0,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/seedsearch", async (req, res) => {
  const { pass } = req.query;
  if (!pass) return res.status(400).json({ error: "pass必須" });
  const hashedId = "@" + crypto.createHash("sha256").update(pass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);
  const role = await getRole(hashedId);
  if (role < 2) return res.status(403).json({ error: "権限不足" });
  const count = role >= 4 ? 200 : role >= 3 ? 100 : 10;
  const seeds = [];
  for (let i = 0; i < count; i++) {
    const seedPass = crypto.randomBytes(4).toString("hex");
    const id = "@" + crypto.createHash("sha256").update(seedPass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);
    seeds.push({ pass: seedPass, id });
  }
  res.json({ seeds });
});

// ----------------------
// アカウント API
// ----------------------

// トークン認証ミドルウェア
async function requireAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/, "").trim();
  if (!token) return res.status(401).json({ error: "認証が必要です" });
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE token=$1`, [token]);
  if (!rows.length) return res.status(401).json({ error: "トークンが無効です" });
  req.account = rows[0];
  next();
}

// アカウント作成
app.post("/account/register", async (req, res) => {
  const { username, bbs_id, bbs_pass } = req.body;
  if (!username || !bbs_id || !bbs_pass)
    return res.status(400).json({ error: "username, bbs_id, bbs_pass は必須" });
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "usernameは英数字・アンダースコア3〜20文字" });

  // bbs_passからIDを計算して一致確認
  const calcId = "@" + crypto.createHash("sha256").update(bbs_pass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);
  if (calcId !== bbs_id)
    return res.status(400).json({ error: "bbs_idとbbs_passが一致しません" });

  const { rows: existing } = await pool.query(`SELECT 1 FROM accounts WHERE username=$1`, [username]);
  if (existing.length) return res.status(409).json({ error: "そのユーザー名は既に使われています" });

  const token = uuidv4();
  await pool.query(
    `INSERT INTO accounts (username, bbs_id, token) VALUES ($1, $2, $3)`,
    [username, bbs_id, token]
  );
  res.status(201).json({ message: "アカウントを作成しました", token });
});

// ログイン（トークン再発行）
app.post("/account/login", async (req, res) => {
  const { bbs_id, bbs_pass } = req.body;
  if (!bbs_id || !bbs_pass)
    return res.status(400).json({ error: "bbs_id, bbs_pass は必須" });

  const calcId = "@" + crypto.createHash("sha256").update(bbs_pass).digest("base64").replace(/[^A-Za-z0-9]/g, "").substr(0, 7);
  if (calcId !== bbs_id)
    return res.status(400).json({ error: "bbs_idとbbs_passが一致しません" });

  const { rows } = await pool.query(`SELECT * FROM accounts WHERE bbs_id=$1`, [bbs_id]);
  if (!rows.length) return res.status(404).json({ error: "アカウントが見つかりません" });

  const token = uuidv4();
  await pool.query(`UPDATE accounts SET token=$1 WHERE bbs_id=$2`, [token, bbs_id]);
  res.json({ message: "ログイン成功", token, username: rows[0].username });
});

// 自分の情報
app.get("/account/me", requireAuth, (req, res) => {
  const { username, bbs_id, created_at } = req.account;
  res.json({ username, bbs_id, created_at });
});

// ----------------------
// Webhook API
// ----------------------

// Webhook一覧取得
app.get("/webhooks", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, url, channel, created_at FROM webhooks WHERE username=$1 ORDER BY id`,
    [req.account.username]
  );
  res.json({ webhooks: rows });
});

// Webhook登録
app.post("/webhooks", requireAuth, async (req, res) => {
  const { url, channel } = req.body;
  if (!url) return res.status(400).json({ error: "urlは必須" });
  const ch = ["chat", "battle"].includes(channel) ? channel : "chat";
  try { new URL(url); } catch { return res.status(400).json({ error: "urlが不正です" }); }

  const { rows: existing } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM webhooks WHERE username=$1`,
    [req.account.username]
  );
  if (parseInt(existing[0].cnt) >= 10)
    return res.status(400).json({ error: "Webhookは1アカウント10件まで" });

  const { rows } = await pool.query(
    `INSERT INTO webhooks (username, url, channel) VALUES ($1, $2, $3) RETURNING *`,
    [req.account.username, url, ch]
  );
  res.status(201).json({ webhook: rows[0] });
});

// Webhook削除
app.delete("/webhooks/:id", requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM webhooks WHERE id=$1 AND username=$2`,
    [parseInt(req.params.id), req.account.username]
  );
  if (!rowCount) return res.status(404).json({ error: "見つかりません" });
  res.json({ message: "削除しました" });
});

// Webhookテスト送信
app.post("/webhooks/:id/test", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM webhooks WHERE id=$1 AND username=$2`,
    [parseInt(req.params.id), req.account.username]
  );
  if (!rows.length) return res.status(404).json({ error: "見つかりません" });
  const payload = {
    event_time: new Date().toISOString(),
    id:         "(テスト)",
    name:       "テストユーザー",
    no:         0,
    content:    "これはWebhookのテスト送信です",
    channel:    rows[0].channel,
  };
  try {
    await axios.post(rows[0].url, payload, { timeout: 5000 });
    res.json({ message: "テスト送信成功" });
  } catch (err) {
    res.status(502).json({ error: "送信失敗: " + err.message });
  }
});

// ----------------------
// ChatWork
// ----------------------
const cwJobs = {};

app.post("/cw-read/start", async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "APIキー必須" });
  const jobId = uuidv4();
  cwJobs[jobId] = { total: 0, done: 0, finished: false, unreadRooms: [], processedRooms: [], errors: [] };
  (async () => {
    try {
      const roomsRes = await axios.get("https://api.chatwork.com/v2/rooms", { headers: { "X-ChatWorkToken": apiKey } });
      const allRooms = roomsRes.data;
      const unreadRooms = allRooms.filter(r => r.unread_num && r.unread_num > 0);
      cwJobs[jobId].total = unreadRooms.length;
      cwJobs[jobId].unreadRooms = unreadRooms.map(r => ({ room_id: r.room_id, name: r.name, unread_num: r.unread_num }));
      if (!unreadRooms.length) { cwJobs[jobId].finished = true; return; }
      let index = 0;
      const interval = setInterval(async () => {
        if (index >= unreadRooms.length) { clearInterval(interval); cwJobs[jobId].finished = true; return; }
        const room = unreadRooms[index++];
        try {
          await axios.put(`https://api.chatwork.com/v2/rooms/${room.room_id}/messages/read`, {}, { headers: { "X-ChatWorkToken": apiKey } });
          cwJobs[jobId].done++;
          cwJobs[jobId].processedRooms.push({ ...room, status: "success" });
        } catch (err) {
          cwJobs[jobId].errors.push({ room_id: room.room_id, name: room.name, error: err.response?.data?.errors?.[0] || err.message });
        }
      }, 1500);
    } catch (err) {
      cwJobs[jobId].finished = true;
      cwJobs[jobId].errors.push({ type: "api_error", error: err.response?.data?.errors?.[0] || err.message });
    }
  })();
  res.json({ jobId });
});

app.get("/cw-read/progress", (req, res) => {
  const { jobId } = req.query;
  if (!jobId || !cwJobs[jobId]) return res.status(404).json({ error: "ジョブ見つからず" });
  res.json(cwJobs[jobId]);
});

app.post("/cw-read/check", async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "APIキー必須" });
  try {
    const roomsRes = await axios.get("https://api.chatwork.com/v2/rooms", { headers: { "X-ChatWorkToken": apiKey } });
    const allRooms = roomsRes.data;
    const unreadRooms = allRooms.filter(r => r.unread_num && r.unread_num > 0);
    res.json({ totalRooms: allRooms.length, unreadRooms: unreadRooms.map(r => ({ room_id: r.room_id, name: r.name, unread_num: r.unread_num })) });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.errors?.[0] || err.message });
  }
});

// ----------------------
// サーバー起動
// ----------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`サーバーがポート ${PORT} で起動しました。`);
});

// ----------------------
// 地震速報（P2P地震情報APIをポーリング）
// ----------------------
let lastEqId = null;

async function checkEarthquake() {
  try {
    const res = await axios.get("https://api.p2pquake.net/v2/history?codes=551&limit=1", { timeout: 5000 });
    const data = res.data;
    if (!data || !data.length) return;
    const eq = data[0];
    if (eq.id === lastEqId) return;
    lastEqId = eq.id;

    const issue   = eq.earthquake?.time ?? null;
    const hypo    = eq.earthquake?.hypocenter;
    const maxScale = eq.earthquake?.maxScale ?? -1;

    let dateStr = "不明";
    if (issue) {
      const d = new Date(issue);
      const pad = n => String(n).padStart(2, "0");
      dateStr = `${d.getFullYear()}年${pad(d.getMonth()+1)}月${pad(d.getDate())}日${pad(d.getHours())}時${pad(d.getMinutes())}分`;
    }

    // 震度変換
    const scaleMap = { 10:"1", 20:"2", 30:"3", 40:"4", 45:"5弱", 50:"5強", 55:"6弱", 60:"6強", 70:"7" };
    const scaleStr = scaleMap[maxScale] ?? "不明";

    let msgContent;
    if (!hypo || !hypo.name || maxScale < 0) {
      msgContent = `${dateStr}に地震が発生しました。\n今後の情報に気をつけてください。`;
    } else {
      msgContent = `${dateStr}に${hypo.name}で震度${scaleStr}の地震が発生しました。\nマグニチュードは${hypo.magnitude ?? "不明"}です。\nこれからも気をつけてください。`;
    }

    const eqTime = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    // 雑談のみに送信
    const { rows: eqPost } = await pool.query(
      `INSERT INTO posts (name, content, id, time) VALUES ('地震速報', $1, '@EQALERT', $2) RETURNING *`,
      [msgContent, eqTime]
    );
    const enriched = (await enrichPosts([eqPost[0]]))[0];
    broadcast("chat", { type: "post", post: enriched });
    console.log("地震速報を送信しました:", dateStr);
  } catch (e) {
    // ポーリングエラーは無視
  }
}

// 1分ごとにチェック
setInterval(checkEarthquake, 60 * 1000);
// 起動時にも取得して lastEqId を初期化（重複送信防止）
axios.get("https://api.p2pquake.net/v2/history?codes=551&limit=1", { timeout: 5000 })
  .then(r => { if (r.data && r.data.length) lastEqId = r.data[0].id; })
  .catch(() => {});
