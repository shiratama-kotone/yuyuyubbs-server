// server.js
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
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
// DB初期化
// ----------------------
async function initDB() {
  const client = await pool.connect();
  try {
    // 雑談投稿テーブル
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
    // バトルスタジアム投稿テーブル
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
    // 権限テーブル（共通）
    await client.query(`CREATE TABLE IF NOT EXISTS admin   (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS summit  (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS manager (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS speaker (id TEXT PRIMARY KEY)`);
    // 装飾テーブル（共通）
    await client.query(`CREATE TABLE IF NOT EXISTS color (id TEXT PRIMARY KEY, color_code TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS "add" (id TEXT PRIMARY KEY, suffix TEXT NOT NULL)`);
    // 設定テーブル
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
    // 規制テーブル
    await client.query(`CREATE TABLE IF NOT EXISTS ng_words  (word TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ban       (id TEXT PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS kill_list (id TEXT PRIMARY KEY)`);

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

// 規制状態をまとめて返す
async function getRestrictionStatus() {
  const prevent       = await getSetting("prevent");
  const restrict      = await getSetting("restrict");
  const stopUntil     = parseInt(await getSetting("stop_until")     ?? "0");
  const prohibitUntil = parseInt(await getSetting("prohibit_until") ?? "0");
  const now = Date.now();
  return {
    prevent:       prevent === "true",
    restrict:      restrict === "true",
    stopActive:    now < stopUntil,
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
    console.log(`${table}: 1000件到達 no=0〜2以外をリセット`);
  }
}

// ----------------------
// ヘルスチェック
// ----------------------
app.get("/",       (req, res) => res.send("掲示板サーバーが正常に動作しています"));
app.get("/health", (req, res) => res.status(200).json({ status: "OK", timestamp: new Date().toISOString() }));

// ----------------------
// 共通投稿取得ロジック
// ----------------------
async function handleGet(table, topicKey, res) {
  try {
    const topic  = await getSetting(topicKey);
    const rs     = await getRestrictionStatus();
    const { rows: posts } = await pool.query(`SELECT * FROM ${table} ORDER BY no DESC`);
    const enriched = await enrichPosts(posts);
    res.json({ topic, posts: enriched, restriction: rs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "データ読み込み失敗" });
  }
}

// ----------------------
// 共通投稿処理ロジック
// ----------------------
async function handlePost(table, topicKey, req, res) {
  const { name, pass, content } = req.query.name ? req.query : req.body;
  if (!name || !pass || !content)
    return res.status(400).json({ error: "全フィールド必須" });

  const now = Date.now();
  if (requestTimestamps[pass] && now - requestTimestamps[pass] < 1000)
    return res.status(429).json({ error: "同じパスワードで1秒に1回まで" });

  const hashedId = "@" + crypto.createHash("sha256").update(pass).digest("hex").substr(0, 7);

  try {
    const role = await getRole(hashedId);

    // kill確認
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
      commandMessage = "/clear";
    }

    // /del 番号 [番号...]
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
      commandMessage = "/del";
    }

    // /destroy 文字列/color [...]
    const destroyMatch = !commandMessage && content.match(/^\/destroy\s+(.+)$/);
    if (destroyMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      const targets = destroyMatch[1].trim().split(/\s+/);
      const colorMap = { blue: 0, darkorange: 1, red: 2, darkcyan: 3 };
      for (const target of targets) {
        if (colorMap[target] !== undefined) {
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
          await pool.query(
            `UPDATE ${table} SET name='削除されました', content='削除されました', id='', deleted=TRUE WHERE content LIKE $1 OR id=$2`,
            [`%${target}%`, target]
          );
        }
      }
      commandMessage = "/destroy";
    }

    // /topic
    const topicMatch = !commandMessage && content.match(/^\/topic\s+(.+)$/);
    if (topicMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      await setSetting(topicKey, topicMatch[1].trim());
      commandMessage = "/topic";
    }

    // /NG 言葉 [...]
    const ngMatch = !commandMessage && content.match(/^\/NG\s+(.+)$/);
    if (ngMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      for (const word of ngMatch[1].trim().split(/\s+/)) {
        await pool.query(`INSERT INTO ng_words (word) VALUES ($1) ON CONFLICT DO NOTHING`, [word]);
      }
      commandMessage = "/NG";
    }

    // /OK 言葉 [...]
    const okMatch = !commandMessage && content.match(/^\/OK\s+(.+)$/);
    if (okMatch) {
      if (role < 2) return res.status(403).json({ error: "権限不足 (マネージャー以上必要)" });
      for (const word of okMatch[1].trim().split(/\s+/)) {
        await pool.query(`DELETE FROM ng_words WHERE word=$1`, [word]);
      }
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

    // /prohibit 分
    const prohibitMatch = !commandMessage && content.match(/^\/prohibit\s+(\d+)$/);
    if (prohibitMatch) {
      if (role < 4) return res.status(403).json({ error: "権限不足 (運営のみ)" });
      await setSetting("prohibit_until", String(Date.now() + parseInt(prohibitMatch[1]) * 60 * 1000));
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
        for (let l = 1; l < grantLevel; l++) {
          await pool.query(`DELETE FROM ${tableMap[l]} WHERE id=$1`, [tid]);
        }
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

    // /kill ID [...]
    const killMatch = !commandMessage && content.match(/^\/kill\s+(.+)$/);
    if (killMatch) {
      if (role < 3) return res.status(403).json({ error: "権限不足 (サミット以上必要)" });
      for (const t of killMatch[1].trim().split(/\s+/)) {
        const tid = t.startsWith("@") ? t : "@" + t;
        await pool.query(`INSERT INTO kill_list (id) VALUES ($1) ON CONFLICT DO NOTHING`, [tid]);
      }
      commandMessage = "/kill";
    }

    // /ban ID/投稿番号 [...]
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

    // /add ID サフィックス
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

    // /color #カラーコード ID
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

    // =====================
    // 通常投稿
    // =====================
    if (!commandMessage && role === 0) {
      const rs = await getRestrictionStatus();

      // /prevent は雑談のみ
      if (table === "posts" && rs.prevent)
        return res.status(403).json({ error: "現在青IDは投稿できません (/prevent中)" });

      // /stop・/prohibit は全サーバー共通
      if (rs.stopActive)
        return res.status(403).json({ error: "現在青IDは投稿できません (/stop中)" });
      if (rs.prohibitActive)
        return res.status(403).json({ error: "現在青IDは投稿できません (/prohibit中)" });

      // /restrict: banされた青IDはどのサーバーも投稿不可
      if (rs.restrict) {
        const { rows: banRows } = await pool.query(`SELECT 1 FROM ban WHERE id=$1`, [hashedId]);
        if (banRows.length)
          return res.status(403).json({ error: "投稿が禁止されています" });
      }

      // NGワードチェック
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
// 掲示板API（雑談）
// ----------------------
app.get( "/api",  (req, res) => handleGet("posts",        "topic",        res));
app.post("/api",  (req, res) => handlePost("posts",       "topic",        req, res));

// ----------------------
// 掲示板API（バトルスタジアム）
// ----------------------
app.get( "/api/battle", (req, res) => handleGet("battle_posts",  "battle_topic", res));
app.post("/api/battle", (req, res) => handlePost("battle_posts", "battle_topic", req, res));

// ----------------------
// 管理用エンドポイント
// ----------------------
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
// ChatWork 未読既読機能
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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`サーバーがポート ${PORT} で起動しました。`);
});
