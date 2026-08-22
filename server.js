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
  distance_origin_name TEXT,
  distance_origin_unit TEXT NOT NULL DEFAULT 'm',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`;

const TABLE_FOODS_SQL = `
CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT '未分类',
  group_id INTEGER NOT NULL,
  legacy_id TEXT,
  avg_price_yuan INTEGER,
  distance_m INTEGER,
  location_label TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  imported_confirmed_count INTEGER NOT NULL DEFAULT 0,
  app_confirmed_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  source_created_at TEXT,
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

  const ensureColumns = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureColumns('groups', {
    distance_origin_name: 'TEXT',
    distance_origin_unit: "TEXT NOT NULL DEFAULT 'm'",
  });
  ensureColumns('foods', {
    legacy_id: 'TEXT',
    avg_price_yuan: 'INTEGER',
    distance_m: 'INTEGER',
    location_label: 'TEXT',
    tags_json: "TEXT NOT NULL DEFAULT '[]'",
    enabled: 'INTEGER NOT NULL DEFAULT 1',
    imported_confirmed_count: 'INTEGER NOT NULL DEFAULT 0',
    app_confirmed_count: 'INTEGER NOT NULL DEFAULT 0',
    source: "TEXT NOT NULL DEFAULT 'manual'",
    source_created_at: 'TEXT',
  });

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
    const seed = [['大米先生', '中式快餐'], ['乡村基', '中式快餐'], ['麦当劳', '西式快餐']];
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
SELECT g.id, g.name, g.code, g.distance_origin_name, g.distance_origin_unit,
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
SELECT f.id, f.name, f.category, f.legacy_id, f.avg_price_yuan, f.distance_m, f.location_label,
  f.tags_json, f.enabled, f.imported_confirmed_count, f.app_confirmed_count, f.source, f.source_created_at,
  COALESCE(ROUND(AVG(fr.score), 1), 0) AS rating,
  COUNT(DISTINCT fr.member_id) AS rating_count,
  ((SELECT COUNT(*) FROM food_visits fv WHERE fv.food_id = f.id) + f.imported_confirmed_count) AS visit_count,
  ((SELECT COUNT(*) FROM food_visits mine_visit
    JOIN group_members mine_member ON mine_member.id = mine_visit.member_id
    WHERE mine_visit.food_id = f.id AND mine_member.group_id = f.group_id AND mine_member.token = ?
  ) + f.imported_confirmed_count) AS my_visit_count,
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
const stmtInsert = db.prepare(`INSERT INTO foods
  (name, category, group_id, legacy_id, avg_price_yuan, distance_m, location_label, tags_json, enabled, imported_confirmed_count, source, source_created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtUpdateFood = db.prepare(`UPDATE foods SET
  name = ?, category = ?, avg_price_yuan = ?, distance_m = ?, location_label = ?, tags_json = ?, enabled = ?, updated_at = datetime('now', 'localtime')
  WHERE id = ? AND group_id = ?`);
const stmtDelete = db.prepare('DELETE FROM foods WHERE id = ? AND group_id = ?');
const stmtConfirmFood = db.prepare(`UPDATE foods
  SET app_confirmed_count = app_confirmed_count + 1, updated_at = datetime('now', 'localtime')
  WHERE id = ? AND group_id = ?`);
const stmtDecrementImportedVisit = db.prepare(`UPDATE foods
  SET imported_confirmed_count = imported_confirmed_count - 1, updated_at = datetime('now', 'localtime')
  WHERE id = ? AND group_id = ? AND imported_confirmed_count > 0`);
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
const stmtDeleteLatestVisit = db.prepare(`DELETE FROM food_visits WHERE id = (
  SELECT id FROM food_visits WHERE food_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1
)`);

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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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
  const categoryValue = item.category ?? item.type;
  const category = typeof categoryValue === 'string' && categoryValue.trim() ? categoryValue.trim() : '未分类';
  const legacyValue = item.legacy_id ?? item.legacyId ?? (typeof item.id === 'string' ? item.id : null);
  const legacy_id = typeof legacyValue === 'string' && legacyValue.trim() ? legacyValue.trim() : null;
  const avg_price_yuan = numberOrNull(item.avg_price_yuan ?? item.avgPriceYuan ?? item.price);
  const distance_m = numberOrNull(item.distance_m ?? item.distanceM ?? item.distance);
  const locationValue = item.location_label ?? item.locationLabel ?? item.area ?? item.district;
  const location_label = typeof locationValue === 'string' && locationValue.trim() ? locationValue.trim() : null;
  const tags = Array.isArray(item.tags) ? [...new Set(item.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 30) : [];
  const enabled = item.enabled ?? item.isAvailable ?? true;
  const imported_confirmed_count = nonNegativeInteger(item.imported_confirmed_count ?? item.confirmed_count ?? item.selectCount ?? 0);
  const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'manual';
  const source_created_at = typeof (item.created_at ?? item.createdAt) === 'string' ? (item.created_at ?? item.createdAt) : null;
  if (!name || name.length > 80 || category.length > 40 || location_label?.length > 50 || legacy_id?.length > 120 || source.length > 30) return null;
  if (avg_price_yuan === false || distance_m === false || imported_confirmed_count === null) return null;
  return { name, category, location_label, legacy_id, avg_price_yuan, distance_m, tags, enabled: Boolean(enabled), imported_confirmed_count, source, source_created_at };
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : false;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function importPayload(body) {
  const items = Array.isArray(body) ? body : body?.restaurants;
  if (!Array.isArray(items)) return null;
  const origin = Array.isArray(body) ? null : body.distance_origin ?? body.distanceOrigin ?? null;
  return { items, origin };
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
  return stmtFoodsByGroup.all(memberToken, memberToken, groupId).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    tags: JSON.parse(row.tags_json || '[]'),
    confirmed_count: (Number(row.imported_confirmed_count) || 0) + (Number(row.app_confirmed_count) || 0),
  }));
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
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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
    if (!normalized) return writeJson(res, 400, { ok: false, msg: '餐厅信息不正确' });
    const group = resolveGroupFromRequest(url, body);
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const result = stmtInsert.run(normalized.name, normalized.category, group.id, normalized.legacy_id, normalized.avg_price_yuan,
      normalized.distance_m, normalized.location_label, JSON.stringify(normalized.tags), normalized.enabled ? 1 : 0, normalized.imported_confirmed_count,
      normalized.source, normalized.source_created_at);
    const newRow = foodRowsForGroup(group.id, memberTokenFromUrl(url)).find((item) => Number(item.id) === Number(result.lastInsertRowid));
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
  if (visitMatch && method === 'DELETE') {
    const foodId = idFromMatch(visitMatch);
    const group = resolveGroupFromRequest(url);
    if (!foodId || !group) return writeJson(res, 404, { ok: false, msg: '餐厅或群组不存在' });
    const food = stmtFoodByIdAndGroup.get(foodId, group.id);
    if (!food) return writeJson(res, 404, { ok: false, msg: '群里没有这个餐厅' });
    const member = stmtMemberByToken.get(group.id, memberTokenFromUrl(url));
    if (!member) return writeJson(res, 403, { ok: false, msg: '请先加入这个群' });
    const info = stmtDeleteLatestVisit.run(food.id, member.id);
    if (!info.changes && !stmtDecrementImportedVisit.run(food.id, group.id).changes) {
      return writeJson(res, 409, { ok: false, msg: '没有可撤销的到访记录' });
    }
    const updated = foodRowsForGroup(group.id, member.token).find((item) => item.id === food.id);
    writeJson(res, 200, { ok: true, food: updated, member });
    return;
  }

  const confirmMatch = url.pathname.match(/^\/api\/foods\/(\d+)\/confirm$/);
  if (confirmMatch && method === 'POST') {
    const foodId = idFromMatch(confirmMatch);
    const group = resolveGroupFromRequest(url);
    if (!foodId || !group) return writeJson(res, 404, { ok: false, msg: '餐厅或群组不存在' });
    const member = stmtMemberByToken.get(group.id, memberTokenFromUrl(url));
    if (!member) return writeJson(res, 403, { ok: false, msg: '请先加入这个群' });
    let info;
    runTransaction(() => {
      info = stmtConfirmFood.run(foodId, group.id);
      if (info.changes) stmtInsertVisit.run(foodId, member.id);
    });
    if (!info.changes) return writeJson(res, 404, { ok: false, msg: '群里没有这个餐厅' });
    const updated = foodRowsForGroup(group.id, member.token).find((item) => Number(item.id) === foodId);
    writeJson(res, 201, { ok: true, food: updated });
    return;
  }

  const updateFoodMatch = url.pathname.match(/^\/api\/foods\/(\d+)$/);
  if (updateFoodMatch && method === 'PATCH') {
    const foodId = idFromMatch(updateFoodMatch);
    const body = await parseBody(req);
    const group = resolveGroupFromRequest(url, body);
    const normalized = normalizeFood(body);
    if (!foodId || !group) return writeJson(res, 404, { ok: false, msg: '餐厅或群组不存在' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: '请先加入这个群' });
    if (!normalized) return writeJson(res, 400, { ok: false, msg: '餐厅信息不正确' });
    const info = stmtUpdateFood.run(normalized.name, normalized.category, normalized.avg_price_yuan, normalized.distance_m,
      normalized.location_label, JSON.stringify(normalized.tags), normalized.enabled ? 1 : 0, foodId, group.id);
    if (!info.changes) return writeJson(res, 404, { ok: false, msg: '群里没有这个餐厅' });
    const updated = foodRowsForGroup(group.id, memberTokenFromUrl(url)).find((item) => Number(item.id) === foodId);
    writeJson(res, 200, { ok: true, food: updated });
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
    const payload = importPayload(body);
    if (!payload) return writeJson(res, 400, { ok: false, msg: '需要餐厅数组或包含 restaurants 的 JSON' });
    const group = resolveGroupFromRequest(url, {});
    if (!group) return writeJson(res, 404, { ok: false, msg: 'group not found' });
    if (!hasGroupAccess(group.id, url)) return writeJson(res, 403, { ok: false, msg: 'join this group first' });
    const next = payload.items.map(normalizeFood).filter(Boolean);
    if (!next.length) return writeJson(res, 400, { ok: false, msg: 'no valid items' });

    runTransaction(() => {
      stmtClearGroup.run(group.id);
      for (const item of next) {
        stmtInsert.run(item.name, item.category, group.id, item.legacy_id, item.avg_price_yuan, item.distance_m,
          item.location_label, JSON.stringify(item.tags), item.enabled ? 1 : 0, item.imported_confirmed_count, item.source, item.source_created_at);
      }
      if (payload.origin?.name) {
        db.prepare('UPDATE groups SET distance_origin_name = ?, distance_origin_unit = ? WHERE id = ?')
          .run(String(payload.origin.name).trim(), String(payload.origin.unit || 'm').trim(), group.id);
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

  if (url.pathname === '/app.js') {
    const filePath = path.join(__dirname, 'app.js');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
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
