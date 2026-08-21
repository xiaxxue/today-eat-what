const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function createSupabase(env) {
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const secretKey = env.SUPABASE_SECRET_KEY || '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const key = secretKey || serviceRoleKey;
  if (!baseUrl || !key) {
    throw new ApiError(503, 'Supabase is not configured');
  }

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...options,
      headers: {
        apikey: key,
        ...(serviceRoleKey ? { Authorization: `Bearer ${serviceRoleKey}` } : {}),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? payload.message || payload.hint || 'Database request failed'
        : 'Database request failed';
      throw new ApiError(response.status, message, payload);
    }
    return payload;
  }

  return {
    list(table, params = {}) {
      return request(`/${table}${queryString(params)}`);
    },
    insert(table, rows, params = {}) {
      return request(`/${table}${queryString(params)}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
    },
    upsert(table, rows, conflict) {
      return request(`/${table}${queryString({ on_conflict: conflict })}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
    },
    remove(table, params = {}) {
      return request(`/${table}${queryString(params)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
    },
    rpc(name, body) {
      return request(`/rpc/${name}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
    },
  };
}

function normalizeFood(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const category = typeof item.category === 'string' && item.category.trim()
    ? item.category.trim()
    : '未分类';
  if (!name || name.length > 80 || category.length > 40) return null;
  return { name, category };
}

function normalizeMember(body) {
  if (!body || typeof body !== 'object') return null;
  const token = typeof body.memberToken === 'string' ? body.memberToken.trim() : '';
  const name = typeof body.memberName === 'string' ? body.memberName.trim() : '';
  if (!token || token.length > 120 || !name || name.length > 30) return null;
  return { token, name };
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => chars[value % chars.length]).join('');
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getAllGroups(db) {
  return db.list('groups', { select: 'id,name,code,created_at', order: 'id.asc', limit: 1000 });
}

async function getGroupById(db, id) {
  if (!positiveId(id)) return null;
  const rows = await db.list('groups', {
    select: 'id,name,code,created_at',
    id: `eq.${Number(id)}`,
    limit: 1,
  });
  return rows[0] || null;
}

async function getGroupByCode(db, code) {
  const wanted = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (!wanted) return null;
  const groups = await getAllGroups(db);
  return groups.find((group) => String(group.code).toLowerCase() === wanted) || null;
}

async function memberCount(db, groupId) {
  const rows = await db.list('group_members', {
    select: 'id',
    group_id: `eq.${groupId}`,
    limit: 1000,
  });
  return rows.length;
}

async function groupWithCount(db, group) {
  if (!group) return null;
  return { ...group, member_count: await memberCount(db, group.id) };
}

async function memberByToken(db, groupId, token) {
  if (!token || token.length > 120) return null;
  const rows = await db.list('group_members', {
    select: 'id,group_id,token,name,joined_at',
    group_id: `eq.${groupId}`,
    token: `eq.${token}`,
    limit: 1,
  });
  return rows[0] || null;
}

async function hasGroupAccess(db, groupId, token) {
  return Boolean(await memberByToken(db, groupId, token));
}

async function upsertMember(db, groupId, memberData) {
  const rows = await db.upsert('group_members', {
    group_id: groupId,
    token: memberData.token,
    name: memberData.name,
  }, 'group_id,token');
  return rows[0];
}

async function resolveGroup(db, url, body) {
  const id = positiveId(url.searchParams.get('groupId'));
  if (id) return getGroupById(db, id);
  const code = url.searchParams.get('groupCode') || (body && body.groupCode);
  if (code) return getGroupByCode(db, String(code));
  return getGroupByCode(db, 'default');
}

function memberTokenFromUrl(url) {
  const token = url.searchParams.get('memberToken') || '';
  return token.length <= 120 ? token.trim() : '';
}

function idsFilter(ids) {
  return `in.(${ids.map(Number).join(',')})`;
}

async function foodRowsForGroup(db, groupId, memberToken = '') {
  const foods = await db.list('foods', {
    select: 'id,name,category,group_id,updated_at',
    group_id: `eq.${groupId}`,
    order: 'id.asc',
    limit: 1000,
  });
  if (!foods.length) return [];

  const foodIds = foods.map((food) => food.id);
  const [ratings, visits, member] = await Promise.all([
    db.list('food_ratings', {
      select: 'food_id,member_id,score',
      food_id: idsFilter(foodIds),
      limit: 10000,
    }),
    db.list('food_visits', {
      select: 'food_id,member_id',
      food_id: idsFilter(foodIds),
      limit: 10000,
    }),
    memberByToken(db, groupId, memberToken),
  ]);

  const byFoodRatings = new Map();
  const byFoodVisits = new Map();
  for (const rating of ratings) {
    const list = byFoodRatings.get(Number(rating.food_id)) || [];
    list.push(rating);
    byFoodRatings.set(Number(rating.food_id), list);
  }
  for (const visit of visits) {
    const id = Number(visit.food_id);
    byFoodVisits.set(id, (byFoodVisits.get(id) || 0) + 1);
  }

  return foods.map((food) => {
    const id = Number(food.id);
    const foodRatings = byFoodRatings.get(id) || [];
    const uniqueMembers = new Set(foodRatings.map((rating) => Number(rating.member_id)));
    const total = foodRatings.reduce((sum, rating) => sum + Number(rating.score), 0);
    const rating = foodRatings.length ? Math.round((total / foodRatings.length) * 10) / 10 : 0;
    const mine = member
      ? foodRatings.find((item) => Number(item.member_id) === Number(member.id))
      : null;
    return {
      ...food,
      id,
      group_id: Number(food.group_id),
      rating,
      rating_count: uniqueMembers.size,
      visit_count: byFoodVisits.get(id) || 0,
      my_rating: mine ? Number(mine.score) : 0,
    };
  }).sort((a, b) =>
    b.rating - a.rating ||
    b.visit_count - a.visit_count ||
    b.rating_count - a.rating_count ||
    a.id - b.id
  );
}

async function listMembers(db, groupId) {
  const members = await db.list('group_members', {
    select: 'id,name,joined_at',
    group_id: `eq.${groupId}`,
    order: 'id.asc',
    limit: 1000,
  });
  if (!members.length) return [];
  const memberIds = members.map((member) => member.id);
  const [ratings, visits] = await Promise.all([
    db.list('food_ratings', {
      select: 'member_id',
      member_id: idsFilter(memberIds),
      limit: 10000,
    }),
    db.list('food_visits', {
      select: 'member_id',
      member_id: idsFilter(memberIds),
      limit: 10000,
    }),
  ]);
  const ratingCounts = new Map();
  const visitCounts = new Map();
  ratings.forEach((item) => ratingCounts.set(Number(item.member_id), (ratingCounts.get(Number(item.member_id)) || 0) + 1));
  visits.forEach((item) => visitCounts.set(Number(item.member_id), (visitCounts.get(Number(item.member_id)) || 0) + 1));
  return members.map((member) => ({
    ...member,
    id: Number(member.id),
    rating_count: ratingCounts.get(Number(member.id)) || 0,
    visit_count: visitCounts.get(Number(member.id)) || 0,
  }));
}

async function requireGroupAccess(db, group, url) {
  if (!group) throw new ApiError(404, 'group not found');
  const token = memberTokenFromUrl(url);
  if (!await hasGroupAccess(db, group.id, token)) {
    throw new ApiError(403, 'join this group first');
  }
  return token;
}

async function handleApi(request, env) {
  const db = createSupabase(env);
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  if (pathname === '/api/health' && method === 'GET') {
    const group = await getGroupByCode(db, 'default');
    return json({ ok: true, database: 'supabase', initialized: Boolean(group) });
  }

  if (pathname === '/api/groups' && method === 'GET') {
    const token = memberTokenFromUrl(url);
    const [allGroups, memberships] = await Promise.all([
      getAllGroups(db),
      token
        ? db.list('group_members', { select: 'group_id', token: `eq.${token}`, limit: 1000 })
        : Promise.resolve([]),
    ]);
    const joined = new Set(memberships.map((item) => Number(item.group_id)));
    const visible = allGroups.filter((group) => group.code === 'default' || joined.has(Number(group.id)));
    const groups = await Promise.all(visible.map((group) => groupWithCount(db, group)));
    return json({ ok: true, groups });
  }

  if (pathname === '/api/groups' && method === 'POST') {
    const body = await readBody(request);
    const name = body && typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 50) throw new ApiError(400, 'group name is required');
    let code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (code && !/^[A-Za-z0-9_-]{3,32}$/.test(code)) {
      throw new ApiError(400, 'group code must be 3-32 letters, numbers, _ or -');
    }
    if (!code) {
      do code = randomCode(); while (await getGroupByCode(db, code));
    } else if (await getGroupByCode(db, code)) {
      throw new ApiError(409, 'group code exists');
    }
    const created = await db.insert('groups', { name, code });
    const memberData = normalizeMember(body);
    const member = memberData ? await upsertMember(db, created[0].id, memberData) : null;
    return json({ ok: true, group: await groupWithCount(db, created[0]), member }, 201);
  }

  if (pathname === '/api/groups/join-by-code' && method === 'POST') {
    const body = await readBody(request);
    const memberData = normalizeMember(body);
    const code = body && typeof body.groupCode === 'string' ? body.groupCode.trim() : '';
    if (!memberData || !code) throw new ApiError(400, 'group code and member are required');
    const group = await getGroupByCode(db, code);
    if (!group) throw new ApiError(404, 'group not found');
    const member = await upsertMember(db, group.id, memberData);
    return json({ ok: true, group: await groupWithCount(db, group), member });
  }

  const groupJoin = pathname.match(/^\/api\/groups\/(\d+)\/join$/);
  if (groupJoin && method === 'POST') {
    const group = await getGroupById(db, groupJoin[1]);
    if (!group) throw new ApiError(404, 'group not found');
    const body = await readBody(request);
    const memberData = normalizeMember(body);
    if (!memberData) throw new ApiError(400, 'member is required');
    if (group.code !== 'default' && !await hasGroupAccess(db, group.id, memberTokenFromUrl(url))) {
      throw new ApiError(403, 'use the group code to join first');
    }
    const member = await upsertMember(db, group.id, memberData);
    return json({ ok: true, group: await groupWithCount(db, group), member });
  }

  const groupMembers = pathname.match(/^\/api\/groups\/(\d+)\/members$/);
  if (groupMembers && method === 'GET') {
    const group = await getGroupById(db, groupMembers[1]);
    await requireGroupAccess(db, group, url);
    return json({ ok: true, group: await groupWithCount(db, group), members: await listMembers(db, group.id) });
  }

  if (pathname === '/api/foods' && method === 'GET') {
    const group = await resolveGroup(db, url);
    const token = await requireGroupAccess(db, group, url);
    return json({ ok: true, foods: await foodRowsForGroup(db, group.id, token), group: await groupWithCount(db, group) });
  }

  if (pathname === '/api/foods' && method === 'POST') {
    const body = await readBody(request);
    const food = normalizeFood(body);
    if (!food) throw new ApiError(400, 'invalid food item');
    const group = await resolveGroup(db, url, body);
    await requireGroupAccess(db, group, url);
    const created = await db.insert('foods', { ...food, group_id: group.id });
    return json({ ok: true, food: created[0] }, 201);
  }

  const rating = pathname.match(/^\/api\/foods\/(\d+)\/rating$/);
  if (rating && method === 'POST') {
    const foodId = positiveId(rating[1]);
    const body = await readBody(request);
    const memberData = normalizeMember(body);
    const score = Number(body && body.score);
    const group = await resolveGroup(db, url, body);
    await requireGroupAccess(db, group, url);
    if (!memberData || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new ApiError(400, 'valid member and score from 1 to 5 are required');
    }
    const foods = await db.list('foods', { select: 'id', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, 'food not found in group');
    const member = await upsertMember(db, group.id, memberData);
    await db.upsert('food_ratings', {
      food_id: foodId,
      member_id: member.id,
      score,
      updated_at: new Date().toISOString(),
    }, 'food_id,member_id');
    const updated = (await foodRowsForGroup(db, group.id, memberData.token)).find((item) => item.id === foodId);
    return json({ ok: true, food: updated, member });
  }

  const visits = pathname.match(/^\/api\/foods\/(\d+)\/visits$/);
  if (visits && method === 'POST') {
    const foodId = positiveId(visits[1]);
    const body = await readBody(request);
    const memberData = normalizeMember(body);
    const group = await resolveGroup(db, url, body);
    await requireGroupAccess(db, group, url);
    if (!memberData) throw new ApiError(400, 'member is required');
    const foods = await db.list('foods', { select: 'id', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, 'food not found in group');
    const member = await upsertMember(db, group.id, memberData);
    await db.insert('food_visits', { food_id: foodId, member_id: member.id });
    const updated = (await foodRowsForGroup(db, group.id, memberData.token)).find((item) => item.id === foodId);
    return json({ ok: true, food: updated, member }, 201);
  }

  const deleteFood = pathname.match(/^\/api\/foods\/(\d+)$/);
  if (deleteFood && method === 'DELETE') {
    const foodId = positiveId(deleteFood[1]);
    const group = await resolveGroup(db, url);
    await requireGroupAccess(db, group, url);
    const removed = await db.remove('foods', { id: `eq.${foodId}`, group_id: `eq.${group.id}` });
    if (!removed || !removed.length) throw new ApiError(404, 'food not found');
    return json({ ok: true, removed: foodId });
  }

  if (pathname === '/api/foods/import' && method === 'POST') {
    const body = await readBody(request);
    if (!Array.isArray(body)) throw new ApiError(400, 'json array required');
    const group = await resolveGroup(db, url);
    const token = await requireGroupAccess(db, group, url);
    const next = body.map(normalizeFood).filter(Boolean);
    if (!next.length) throw new ApiError(400, 'no valid items');
    await db.rpc('replace_group_foods', {
      p_group_id: group.id,
      p_items: next,
    });
    const foods = await foodRowsForGroup(db, group.id, token);
    return json({ ok: true, foods, total: foods.length, group: await groupWithCount(db, group) });
  }

  if (pathname === '/api/foods/export' && method === 'GET') {
    const group = await resolveGroup(db, url);
    const token = await requireGroupAccess(db, group, url);
    const foods = await foodRowsForGroup(db, group.id, token);
    return json({ ok: true, foods, exportedAt: new Date().toISOString(), total: foods.length, group: await groupWithCount(db, group) });
  }

  throw new ApiError(404, 'Not Found');
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  try {
    return await handleApi(context.request, context.env);
  } catch (error) {
    console.error('api request failed', error);
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : 'internal server error';
    return json({ ok: false, msg: message }, status);
  }
}
