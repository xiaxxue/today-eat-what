const http = require('node:http');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'foods.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const TABLE_GROUPS_SQL = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`;

const TABLE_FOODS_SQL = `
CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '未分类',
  group_id INTEGER NOT NULL,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`;

const TABLE_MEMBERS_SQL = `
CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  joined_at TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(group_id, token),
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
);
`;

const TABLE_RATINGS_SQL = `
CREATE TABLE IF NOT EXISTS food_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  updated_at TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(food_id, member_id),
  FOREIGN KEY(food_id) REFERENCES foods(id) ON DELETE CASCADE,
  FOREIGN KEY(member_id) REFERENCES group_members(id) ON DELETE CASCADE
);
`;

const TABLE_VISITS_SQL = `
CREATE TABLE IF NOT EXISTS food_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  food_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  visited_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY(food_id) REFERENCES foods(id) ON DELETE CASCADE,
  FOREIGN KEY(member_id) REFERENCES group_members(id) ON DELETE CASCADE
);
`;

function runTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      console.error('rollback failed', rollbackErr);
    }
    throw err;
  }
}

function ensureDb() {
  db.exec(TABLE_GROUPS_SQL);
  db.exec(TABLE_FOODS_SQL);
  db.exec(TABLE_MEMBERS_SQL);
  db.exec(TABLE_RATINGS_SQL);
  db.exec(TABLE_VISITS_SQL);

  const hasGroupId = db
    .prepare('PRAGMA table_info(foods)')
    .all()
    .some((c) => c.name === 'group_id');

  if (!hasGroupId) {
    db.exec('ALTER TABLE foods ADD COLUMN group_id INTEGER');
    db.exec('UPDATE foods SET group_id = 1 WHERE group_id IS NULL');
  }

  let defaultGroupId;
  const defaultGroup = db.prepare("SELECT id FROM groups WHERE code = 'default'").get();
  if (!defaultGroup) {
    db.prepare('INSERT INTO groups (name, code) VALUES (?, ?)').run('默认吃饭群', 'default');
    defaultGroupId = Number(db.prepare('SELECT last_insert_rowid() as id').get().id);
  } else {
    defaultGroupId = Number(defaultGroup.id);
  }

  const defaultCount = db.prepare('SELECT COUNT(*) as c FROM foods WHERE group_id = ?').get(defaultGroupId).c;
  if (defaultCount === 0) {
    const seed = [
      ['番茄鸡蛋盖浇饭', '主食'],
      ['番茄牛腩面', '面食'],
      ['酸辣土豆丝', '热菜'],
      ['清炒西蓝花', '素菜'],
      ['红烧排骨', '热菜'],
      ['麻婆豆腐', '热菜'],
      ['蛋炒饭', '主食'],
    ];
    const ins = db.prepare('INSERT INTO foods (name, category, group_id) VALUES (?, ?, ?)');
    runTransaction(() => {
      for (const [name, category] of seed) {
        ins.run(name, category, defaultGroupId);
      }
    });
  }

  return { defaultGroupId };
}

const { defaultGroupId } = ensureDb();

const GROUP_FIELDS_SQL = `
SELECT g.id, g.name, g.code,
  (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
FROM groups g
`;
const stmtGroupsForMember = db.prepare(`${GROUP_FIELDS_SQL}
WHERE g.code = 'default' OR EXISTS (
  SELECT 1 FROM group_members mine WHERE mine.group_id = g.id AND mine.token = ?
)
ORDER BY g.id ASC`);
const stmtGroupById = db.prepare(`${GROUP_FIELDS_SQL} WHERE g.id = ?`);
const stmtGroupByCode = db.prepare(`${GROUP_FIELDS_SQL} WHERE g.code = ? COLLATE NOCASE`);
const stmtCreateGroup = db.prepare('INSERT INTO groups (name, code) VALUES (?, ?)');
const stmtFoodsByGroup = db.prepare(`
SELECT f.id, f.name, f.category,
  COALESCE(ROUND(AVG(fr.score), 1), 0) AS rating,
  COUNT(DISTINCT fr.member_id) AS rating_count,
  (SELECT COUNT(*) FROM food_visits fv WHERE fv.food_id = f.id) AS visit_count,
  COALESCE((
    SELECT mine.score
    FROM food_ratings mine
    JOIN group_members me ON me.id = mine.member_id
    WHERE mine.food_id = f.id AND me.group_id = f.group_id AND me.token = ?
  ), 0) AS my_rating
FROM foods f
LEFT JOIN food_ratings fr ON fr.food_id = f.id
WHERE f.group_id = ?
GROUP BY f.id
ORDER BY rating DESC, visit_count DESC, rating_count DESC, f.id ASC
`);
const stmtInsert = db.prepare('INSERT INTO foods (name, category, group_id) VALUES (?, ?, ?)');
const stmtDelete = db.prepare('DELETE FROM foods WHERE id = ? AND group_id = ?');
const stmtClearGroup = db.prepare('DELETE FROM foods WHERE group_id = ?');
const stmtFoodByIdAndGroup = db.prepare('SELECT id, name, category, group_id FROM foods WHERE id = ? AND group_id = ?');
const stmtMemberByToken = db.prepare('SELECT id, group_id, token, name, joined_at FROM group_members WHERE group_id = ? AND token = ?');
const stmtMembersByGroup = db.prepare(`
SELECT gm.id, gm.name, gm.joined_at,
  (SELECT COUNT(*) FROM food_ratings fr WHERE fr.member_id = gm.id) AS rating_count,
  (SELECT COUNT(*) FROM food_visits fv WHERE fv.member_id = gm.id) AS visit_count
FROM group_members gm WHERE gm.group_id = ? ORDER BY gm.id ASC
`);
const stmtUpsertMember = db.prepare(`
INSERT INTO group_members (group_id, token, name) VALUES (?, ?, ?)
ON CONFLICT(group_id, token) DO UPDATE SET name = excluded.name
`);
const stmtUpsertRating = db.prepare(`
INSERT INTO food_ratings (food_id, member_id, score) VALUES (?, ?, ?)
ON CONFLICT(food_id, member_id) DO UPDATE SET score = excluded.score, updated_at = datetime('now', 'localtime')
`);
const stmtInsertVisit = db.prepare('INSERT INTO food_visits (food_id, member_id) VALUES (?, ?)');

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function resolveGroupFromRequest(reqUrl, body) {
  const queryId = Number(reqUrl.searchParams.get('groupId'));
  if (Number.isInteger(queryId) && queryId > 0) {
    const g = stmtGroupById.get(queryId);
    return g ? g : null;
  }
  const code = reqUrl.searchParams.get('groupCode') || (body && body.groupCode);
  if (code) {
    const g = stmtGroupByCode.get(String(code).trim());
    return g ? g : null;
  }
  return stmtGroupById.get(defaultGroupId);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function writeJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function writeText(res, statusCode, content, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(content);
}

function normalizeFood(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;
  const category = typeof item.category === 'string' && item.category.trim() ? item.category.trim() : '未分类';
  return { name, category };
}

function normalizeMember(body) {
  if (!body || typeof body !== 'object') return null;
  const token = typeof body.memberToken === 'string' ? body.memberToken.trim() : '';
  const name = typeof body.memberName === 'string' ? body.memberName.trim() : '';
  if (!token || token.length > 120 || !name || name.length > 30) return null;
  return { token, name };
}

function upsertMember(groupId, memberData) {
  stmtUpsertMember.run(groupId, memberData.token, memberData.name);
  return stmtMemberByToken.get(groupId, memberData.token);
}

function memberTokenFromUrl(url) {
  const token = url.searchParams.get('memberToken');
  return typeof token === 'string' ? token.trim() : '';
}

function hasGroupAccess(groupId, url) {
  const token = memberTokenFromUrl(url);
  return Boolean(token && stmtMemberByToken.get(groupId, token));
}

function foodRowsForGroup(groupId, memberToken = '') {
  return stmtFoodsByGroup.all(memberToken, groupId);
}

function idFromMatch(match) {
  const id = Number(match && match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getIdFromPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const id = Number(last);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/foods' && method === 'GET') {
    const group = resolveGroupFromRequest(url);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const rows = foodRowsForGroup(group.id, memberTokenFromUrl(url));
    writeJson(res, 200, { ok: true, foods: rows, group });
    return;
  }

  if (url.pathname === '/api/foods' && method === 'POST') {
    const body = await parseBody(req);
    if (!body) return writeJson(res, 400, { ok: false, msg: 'invalid json' });
    const normalized = normalizeFood(body);
    if (!normalized) return writeJson(res, 400, { ok: false, msg: 'invalid food item' });
    const group = resolveGroupFromRequest(url, body);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const result = stmtInsert.run(normalized.name, normalized.category, group.id);
    const newRow = { id: result.lastInsertRowid, name: normalized.name, category: normalized.category, group_id: group.id };
    writeJson(res, 201, { ok: true, food: newRow });
    return;
  }

  const ratingMatch = url.pathname.match(/^\/api\/foods\/(\d+)\/rating$/);
  if (ratingMatch && method === 'POST') {
    const foodId = idFromMatch(ratingMatch);
    const group = resolveGroupFromRequest(url);
    const body = await parseBody(req);
    const memberData = normalizeMember(body);
    const score = Number(body && body.score);
    if (!foodId || !group) return writeJson(res, 404, { ok: false, msg: 'food or group not found' });
    if (!memberData) return writeJson(res, 400, { ok: false, msg: 'member name and token are required' });
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return writeJson(res, 400, { ok: false, msg: 'score must be an integer from 1 to 5' });
    }
    const food = stmtFoodByIdAndGroup.get(foodId, group.id);
    if (!food) return writeJson(res, 404, { ok: false, msg: 'food not found in group' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const member = upsertMember(group.id, memberData);
    stmtUpsertRating.run(food.id, member.id, score);
    const updated = foodRowsForGroup(group.id, memberData.token).find((item) => item.id === food.id);
    writeJson(res, 200, { ok: true, food: updated, member });
    return;
  }

  const visitMatch = url.pathname.match(/^\/api\/foods\/(\d+)\/visits$/);
  if (visitMatch && method === 'POST') {
    const foodId = idFromMatch(visitMatch);
    const group = resolveGroupFromRequest(url);
    const body = await parseBody(req);
    const memberData = normalizeMember(body);
    if (!foodId || !group) return writeJson(res, 404, { ok: false, msg: 'food or group not found' });
    if (!memberData) return writeJson(res, 400, { ok: false, msg: 'member name and token are required' });
    const food = stmtFoodByIdAndGroup.get(foodId, group.id);
    if (!food) return writeJson(res, 404, { ok: false, msg: 'food not found in group' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const member = upsertMember(group.id, memberData);
    stmtInsertVisit.run(food.id, member.id);
    const updated = foodRowsForGroup(group.id, memberData.token).find((item) => item.id === food.id);
    writeJson(res, 201, { ok: true, food: updated, member });
    return;
  }

  if (url.pathname.startsWith('/api/foods/') && method === 'DELETE') {
    const id = getIdFromPath(url.pathname);
    if (!id) return writeJson(res, 400, { ok: false, msg: 'invalid id' });
    const group = resolveGroupFromRequest(url);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const info = stmtDelete.run(id, group.id);
    if (info.changes === 0) return writeJson(res, 404, { ok: false, msg: 'not found' });
    writeJson(res, 200, { ok: true, removed: id });
    return;
  }

  if (url.pathname === '/api/foods/import' && method === 'POST') {
    const body = await parseBody(req);
    if (!Array.isArray(body)) return writeJson(res, 400, { ok: false, msg: 'json array required' });
    const group = resolveGroupFromRequest(url, {});
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const next = body.map(normalizeFood).filter(Boolean);
    if (!next.length) return writeJson(res, 400, { ok: false, msg: 'no valid items' });

    runTransaction(() => {
      stmtClearGroup.run(group.id);
      const ins = db.prepare('INSERT INTO foods (name, category, group_id) VALUES (?, ?, ?)');
      for (const item of next) {
        ins.run(item.name, item.category, group.id);
      }
    });

    const rows = foodRowsForGroup(group.id, memberTokenFromUrl(url));
    writeJson(res, 200, { ok: true, foods: rows, total: rows.length, group });
    return;
  }

  if (url.pathname === '/api/foods/export' && method === 'GET') {
    const group = resolveGroupFromRequest(url);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const rows = foodRowsForGroup(group.id, memberTokenFromUrl(url));
    writeJson(res, 200, {
      ok: true,
      foods: rows,
      exportedAt: new Date().toISOString(),
      total: rows.length,
      group,
    });
    return;
  }

  const groupMembersMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/members$/);
  if (groupMembersMatch && method === 'GET') {
    const groupId = idFromMatch(groupMembersMatch);
    const group = groupId ? stmtGroupById.get(groupId) : null;
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const members = stmtMembersByGroup.all(group.id);
    writeJson(res, 200, { ok: true, group, members });
    return;
  }

  if (url.pathname === '/api/groups/join-by-code' && method === 'POST') {
    const body = await parseBody(req);
    const memberData = normalizeMember(body);
    const code = body && typeof body.groupCode === 'string' ? body.groupCode.trim() : '';
    if (!memberData || !code) return writeJson(res, 400, { ok: false, msg: 'group code, member name and token are required' });
    const group = stmtGroupByCode.get(code);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    const member = upsertMember(group.id, memberData);
    const updatedGroup = stmtGroupById.get(group.id);
    writeJson(res, 200, { ok: true, group: updatedGroup, member });
    return;
  }

  const groupJoinMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/join$/);
  if (groupJoinMatch && method === 'POST') {
    const groupId = idFromMatch(groupJoinMatch);
    const group = groupId ? stmtGroupById.get(groupId) : null;
    const body = await parseBody(req);
    const memberData = normalizeMember(body);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!memberData) return writeJson(res, 400, { ok: false, msg: 'member name and token are required' });
    if (group.code !== 'default' && !hasGroupAccess(group.id, url)) {
      return writeJson(res, 403, { ok: false, msg: 'use the group code to join first' });
    }
    const member = upsertMember(group.id, memberData);
    const updatedGroup = stmtGroupById.get(group.id);
    writeJson(res, 200, { ok: true, group: updatedGroup, member });
    return;
  }

  if (url.pathname === '/api/groups' && method === 'GET') {
    const groups = stmtGroupsForMember.all(memberTokenFromUrl(url));
    writeJson(res, 200, { ok: true, groups });
    return;
  }

  if (url.pathname === '/api/groups' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || typeof body.name !== 'string' || !body.name.trim()) {
      return writeJson(res, 400, { ok: false, msg: 'group name is required' });
    }

    let code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      let conflict = true;
      while (conflict) {
        code = randomCode();
        conflict = Boolean(stmtGroupByCode.get(code));
      }
    } else {
      const exist = stmtGroupByCode.get(code);
      if (exist) return writeJson(res, 409, { ok: false, msg: 'group code exists' });
    }

    const info = stmtCreateGroup.run(body.name.trim(), code);
    const groupId = Number(info.lastInsertRowid);
    const memberData = normalizeMember(body);
    const member = memberData ? upsertMember(groupId, memberData) : null;
    const group = stmtGroupById.get(groupId);
    writeJson(res, 201, { ok: true, group, member });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
    return;
  }

  writeText(res, 404, 'Not Found');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('request failed', err);
    if (!res.headersSent) writeJson(res, 500, { ok: false, msg: 'internal server error' });
    else res.end();
  });
});

const port = Number(process.env.PORT || 3000);
// 默认监听所有网卡，方便同一局域网的吃饭搭子访问同一份数据库。
// 仅想本机使用时可用 HOST=127.0.0.1 npm start。
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`server running at http://${host}:${port}`);
  console.log(`data file: ${DB_PATH}`);
});
