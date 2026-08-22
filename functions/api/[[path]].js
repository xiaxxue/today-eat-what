const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ACCESS_COOKIE = 'wte_access_token';
const REFRESH_COOKIE = 'wte_refresh_token';

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function json(data, status = 200, cookies = []) {
  const headers = new Headers({
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  cookies.forEach((item) => headers.append('Set-Cookie', item));
  return new Response(JSON.stringify(data), { status, headers });
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function getSupabaseConfig(env) {
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
  return { baseUrl, secretKey, publishableKey };
}

function createSupabase(env) {
  const { baseUrl, secretKey } = getSupabaseConfig(env);
  if (!baseUrl || !secretKey) throw new ApiError(503, 'Supabase database is not configured');

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...options,
      headers: {
        apikey: secretKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? payload.message || payload.hint || payload.details || 'Database request failed'
        : 'Database request failed';
      throw new ApiError(response.status, message, payload);
    }
    return payload;
  }

  return {
    list(table, params = {}) {
      return request(`/${table}${queryString(params)}`);
    },
    insert(table, rows) {
      return request(`/${table}`, {
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
    update(table, params = {}, values = {}) {
      return request(`/${table}${queryString(params)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(values),
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

async function authRequest(env, path, options = {}) {
  const { baseUrl, publishableKey } = getSupabaseConfig(env);
  if (!baseUrl || !publishableKey) throw new ApiError(503, 'Supabase Auth is not configured');
  const response = await fetch(`${baseUrl}/auth/v1${path}`, {
    ...options,
    headers: {
      apikey: publishableKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      ? payload.msg || payload.message || payload.error_description || payload.error || 'Authentication failed'
      : 'Authentication failed';
    throw new ApiError(response.status === 422 ? 400 : response.status, message, payload);
  }
  return payload;
}

function parseCookies(request) {
  const result = {};
  const raw = request.headers.get('Cookie') || '';
  raw.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
    }
  });
  return result;
}

function cookie(name, value, request, options = {}) {
  const secure = new URL(request.url).protocol === 'https:';
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Number(options.maxAge) || 0)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionCookies(session, request) {
  if (!session || !session.access_token || !session.refresh_token) return [];
  return [
    cookie(ACCESS_COOKIE, session.access_token, request, { maxAge: Math.max(60, Number(session.expires_in) || 3600) }),
    cookie(REFRESH_COOKIE, session.refresh_token, request, { maxAge: 60 * 60 * 24 * 30, path: '/api/auth' }),
  ];
}

function clearSessionCookies(request) {
  return [
    cookie(ACCESS_COOKIE, '', request, { maxAge: 0 }),
    cookie(REFRESH_COOKIE, '', request, { maxAge: 0, path: '/api/auth' }),
  ];
}

function publicUser(user) {
  if (!user) return null;
  const displayName = typeof user.user_metadata?.display_name === 'string'
    ? user.user_metadata.display_name.trim()
    : '';
  return {
    id: user.id,
    email: user.email || '',
    display_name: displayName || String(user.email || '吃饭搭子').split('@')[0],
  };
}

async function requireUser(request, env) {
  const token = parseCookies(request)[ACCESS_COOKIE];
  if (!token) throw new ApiError(401, '请先登录');
  const user = await authRequest(env, '/user', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!user?.id) throw new ApiError(401, '登录已过期');
  return user;
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

function normalizeFood(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const categoryValue = item.category ?? item.type;
  const category = typeof categoryValue === 'string' && categoryValue.trim()
    ? categoryValue.trim()
    : '未分类';
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

function userName(user) {
  const metadataName = typeof user.user_metadata?.display_name === 'string'
    ? user.user_metadata.display_name.trim()
    : '';
  return (metadataName || String(user.email || '吃饭搭子').split('@')[0] || '吃饭搭子').slice(0, 30);
}

function idsFilter(ids) {
  return `in.(${ids.map(Number).join(',')})`;
}

async function getAllGroups(db) {
  return db.list('groups', { select: 'id,name,code,owner_id,is_personal,created_at', order: 'id.asc', limit: 1000 });
}

async function getGroupById(db, id) {
  if (!positiveId(id)) return null;
  const rows = await db.list('groups', {
    select: 'id,name,code,owner_id,is_personal,created_at',
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
  const rows = await db.list('group_members', { select: 'id', group_id: `eq.${groupId}`, limit: 1000 });
  return rows.length;
}

async function groupWithCount(db, group, userId = '') {
  if (!group) return null;
  const { owner_id: ownerId, is_personal: isPersonal, ...safeGroup } = group;
  return {
    ...safeGroup,
    member_count: await memberCount(db, group.id),
    is_owner: Boolean(userId && ownerId === userId),
    is_personal: Boolean(isPersonal),
  };
}

async function memberByUser(db, groupId, userId) {
  if (!userId) return null;
  const rows = await db.list('group_members', {
    select: 'id,group_id,user_id,name,role,joined_at',
    group_id: `eq.${groupId}`,
    user_id: `eq.${userId}`,
    limit: 1,
  });
  return rows[0] || null;
}

async function upsertUserMember(db, groupId, user, role = 'member') {
  const existing = await memberByUser(db, groupId, user.id);
  const rows = await db.upsert('group_members', {
    group_id: groupId,
    user_id: user.id,
    token: null,
    name: userName(user),
    role: existing?.role || role,
  }, 'group_id,user_id');
  return rows[0];
}

async function membershipsForUser(db, userId) {
  return db.list('group_members', {
    select: 'group_id',
    user_id: `eq.${userId}`,
    order: 'id.asc',
    limit: 1000,
  });
}

async function ensurePersonalGroup(db, user) {
  const existing = await db.list('groups', {
    select: 'id,name,code,owner_id,is_personal,created_at',
    owner_id: `eq.${user.id}`,
    is_personal: 'eq.true',
    limit: 1,
  });
  if (existing[0]) {
    await upsertUserMember(db, existing[0].id, user, 'owner');
    return existing[0];
  }
  let code;
  do code = randomCode(); while (await getGroupByCode(db, code));
  let group;
  let createdPersonal = false;
  try {
    const created = await db.insert('groups', { name: '我的吃饭群', code, owner_id: user.id, is_personal: true });
    group = created[0];
    createdPersonal = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const raced = await db.list('groups', {
      select: 'id,name,code,owner_id,is_personal,created_at',
      owner_id: `eq.${user.id}`,
      is_personal: 'eq.true',
      limit: 1,
    });
    group = raced[0];
    if (!group) throw error;
  }
  await upsertUserMember(db, group.id, user, 'owner');
  if (createdPersonal) {
    await db.insert('foods', [
      { name: '大米先生', category: '中式快餐', group_id: group.id },
      { name: '乡村基', category: '中式快餐', group_id: group.id },
      { name: '麦当劳', category: '西式快餐', group_id: group.id },
    ]);
  }
  return group;
}

async function resolveGroup(db, url, body, user) {
  const id = positiveId(url.searchParams.get('groupId'));
  if (id) return getGroupById(db, id);
  const code = url.searchParams.get('groupCode') || body?.groupCode;
  if (code) return getGroupByCode(db, String(code));
  const memberships = await membershipsForUser(db, user.id);
  return memberships[0] ? getGroupById(db, memberships[0].group_id) : null;
}

async function requireGroupAccess(db, group, user) {
  if (!group) throw new ApiError(404, '群组不存在');
  const member = await memberByUser(db, group.id, user.id);
  if (!member) throw new ApiError(403, '你还没有加入这个群');
  return member;
}

async function foodRowsForGroup(db, groupId, memberId) {
  const foods = await db.list('foods', {
    select: 'id,name,category,group_id,legacy_id,avg_price_yuan,distance_m,location_label,tags,enabled,imported_confirmed_count,source,source_created_at,updated_at',
    group_id: `eq.${groupId}`,
    order: 'id.asc',
    limit: 1000,
  });
  if (!foods.length) return [];
  const foodIds = foods.map((food) => food.id);
  const [ratings, visits, picks] = await Promise.all([
    db.list('food_ratings', { select: 'food_id,member_id,score', food_id: idsFilter(foodIds), limit: 10000 }),
    db.list('food_visits', { select: 'food_id,member_id', food_id: idsFilter(foodIds), limit: 10000 }),
    db.list('meal_picks', { select: 'food_id', group_id: `eq.${groupId}`, food_id: idsFilter(foodIds), limit: 10000 }),
  ]);
  const byFoodRatings = new Map();
  const byFoodVisits = new Map();
  const byFoodMyVisits = new Map();
  const byFoodPicks = new Map();
  for (const rating of ratings) {
    const list = byFoodRatings.get(Number(rating.food_id)) || [];
    list.push(rating);
    byFoodRatings.set(Number(rating.food_id), list);
  }
  for (const visit of visits) {
    const id = Number(visit.food_id);
    byFoodVisits.set(id, (byFoodVisits.get(id) || 0) + 1);
    if (Number(visit.member_id) === Number(memberId)) {
      byFoodMyVisits.set(id, (byFoodMyVisits.get(id) || 0) + 1);
    }
  }
  for (const pick of picks) {
    const id = Number(pick.food_id);
    byFoodPicks.set(id, (byFoodPicks.get(id) || 0) + 1);
  }
  return foods.map((food) => {
    const id = Number(food.id);
    const foodRatings = byFoodRatings.get(id) || [];
    const uniqueMembers = new Set(foodRatings.map((rating) => Number(rating.member_id)));
    const total = foodRatings.reduce((sum, rating) => sum + Number(rating.score), 0);
    const mine = foodRatings.find((item) => Number(item.member_id) === Number(memberId));
    return {
      ...food,
      id,
      group_id: Number(food.group_id),
      rating: foodRatings.length ? Math.round((total / foodRatings.length) * 10) / 10 : 0,
      rating_count: uniqueMembers.size,
      visit_count: (byFoodVisits.get(id) || 0) + (Number(food.imported_confirmed_count) || 0),
      my_visit_count: (byFoodMyVisits.get(id) || 0) + (Number(food.imported_confirmed_count) || 0),
      my_rating: mine ? Number(mine.score) : 0,
      confirmed_count: (Number(food.imported_confirmed_count) || 0) + (byFoodPicks.get(id) || 0),
    };
  }).sort((a, b) => b.rating - a.rating || b.visit_count - a.visit_count || b.rating_count - a.rating_count || a.id - b.id);
}

async function listMembers(db, groupId) {
  const members = await db.list('group_members', {
    select: 'id,name,role,joined_at',
    group_id: `eq.${groupId}`,
    order: 'id.asc',
    limit: 1000,
  });
  if (!members.length) return [];
  const memberIds = members.map((member) => member.id);
  const [ratings, visits] = await Promise.all([
    db.list('food_ratings', { select: 'member_id', member_id: idsFilter(memberIds), limit: 10000 }),
    db.list('food_visits', { select: 'member_id', member_id: idsFilter(memberIds), limit: 10000 }),
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

async function handleAuth(request, env, pathname, method) {
  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, '请输入有效邮箱');
    if (password.length < 8) throw new ApiError(400, '密码至少需要 8 位');
    if (!displayName || displayName.length > 30) throw new ApiError(400, '昵称需要 1-30 个字符');
    const redirectTo = new URL(request.url).origin;
    const data = await authRequest(env, `/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      body: JSON.stringify({ email, password, data: { display_name: displayName } }),
    });
    const session = data.session || (data.access_token ? data : null);
    return json({ ok: true, user: publicUser(data.user || session?.user), needs_confirmation: !session }, 201, sessionCookies(session, request));
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) throw new ApiError(400, '请输入邮箱和密码');
    const session = await authRequest(env, '/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return json({ ok: true, user: publicUser(session.user) }, 200, sessionCookies(session, request));
  }

  if (pathname === '/api/auth/refresh' && method === 'POST') {
    const refreshToken = parseCookies(request)[REFRESH_COOKIE];
    if (!refreshToken) throw new ApiError(401, '登录已过期');
    const session = await authRequest(env, '/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return json({ ok: true, user: publicUser(session.user) }, 200, sessionCookies(session, request));
  }

  if (pathname === '/api/auth/adopt-session' && method === 'POST') {
    const body = await readBody(request);
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
    if (!refreshToken) throw new ApiError(400, '验证链接无效');
    const session = await authRequest(env, '/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return json({ ok: true, user: publicUser(session.user) }, 200, sessionCookies(session, request));
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    const user = await requireUser(request, env);
    return json({ ok: true, user: publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(request)[ACCESS_COOKIE];
    if (token) {
      try {
        await authRequest(env, '/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      } catch (error) {
        console.warn('Supabase logout failed', error?.message || error);
      }
    }
    return json({ ok: true }, 200, clearSessionCookies(request));
  }
  return null;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  const authResponse = await handleAuth(request, env, pathname, method);
  if (authResponse) return authResponse;

  const db = createSupabase(env);
  if (pathname === '/api/health' && method === 'GET') {
    const group = await getGroupByCode(db, 'default');
    return json({ ok: true, database: 'supabase', initialized: Boolean(group), auth: Boolean(getSupabaseConfig(env).publishableKey) });
  }

  const user = await requireUser(request, env);

  if (pathname === '/api/groups' && method === 'GET') {
    await ensurePersonalGroup(db, user);
    const memberships = await membershipsForUser(db, user.id);
    const groupIds = memberships.map((item) => Number(item.group_id));
    const rows = groupIds.length
      ? await db.list('groups', { select: 'id,name,code,owner_id,is_personal,created_at', id: idsFilter(groupIds), order: 'id.asc', limit: 1000 })
      : [];
    const groups = await Promise.all(rows.map((group) => groupWithCount(db, group, user.id)));
    return json({ ok: true, groups, user: publicUser(user) });
  }

  if (pathname === '/api/groups' && method === 'POST') {
    const body = await readBody(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 50) throw new ApiError(400, '群名不能为空');
    let code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (code && !/^[A-Za-z0-9_-]{3,32}$/.test(code)) throw new ApiError(400, '群码只能使用 3-32 位字母、数字、_ 或 -');
    if (!code) {
      do code = randomCode(); while (await getGroupByCode(db, code));
    } else if (await getGroupByCode(db, code)) {
      throw new ApiError(409, '这个群码已经存在');
    }
    const created = await db.insert('groups', { name, code, owner_id: user.id, is_personal: false });
    const member = await upsertUserMember(db, created[0].id, user, 'owner');
    return json({ ok: true, group: await groupWithCount(db, created[0], user.id), member }, 201);
  }

  if (pathname === '/api/groups/join-by-code' && method === 'POST') {
    const body = await readBody(request);
    const code = typeof body?.groupCode === 'string' ? body.groupCode.trim() : '';
    if (!code) throw new ApiError(400, '请输入群码');
    const group = await getGroupByCode(db, code);
    if (!group) throw new ApiError(404, '没有找到这个群');
    const member = await upsertUserMember(db, group.id, user, 'member');
    return json({ ok: true, group: await groupWithCount(db, group, user.id), member });
  }

  const groupRoute = pathname.match(/^\/api\/groups\/(\d+)$/);
  if (groupRoute && method === 'PATCH') {
    const body = await readBody(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) throw new ApiError(400, '群名不能为空');
    if (name.length > 50) throw new ApiError(400, '群名不能超过 50 个字');
    const group = await getGroupById(db, groupRoute[1]);
    await requireGroupAccess(db, group, user);
    if (group.owner_id !== user.id) throw new ApiError(403, '只有群主可以修改群名');
    const updated = await db.update('groups', {
      id: `eq.${group.id}`,
      owner_id: `eq.${user.id}`,
    }, { name });
    if (!updated?.length) throw new ApiError(409, '群组状态已变化，请刷新后重试');
    return json({ ok: true, group: await groupWithCount(db, updated[0], user.id) });
  }

  if (groupRoute && method === 'DELETE') {
    const group = await getGroupById(db, groupRoute[1]);
    await requireGroupAccess(db, group, user);
    if (group.owner_id !== user.id) throw new ApiError(403, '只有群主可以删除这个群');
    if (group.is_personal) throw new ApiError(400, '系统个人群不能删除');
    const removed = await db.remove('groups', {
      id: `eq.${group.id}`,
      owner_id: `eq.${user.id}`,
      is_personal: 'eq.false',
    });
    if (!removed?.length) throw new ApiError(409, '群组状态已变化，请刷新后重试');
    return json({ ok: true, removed: group.id });
  }

  const groupMembership = pathname.match(/^\/api\/groups\/(\d+)\/membership$/);
  if (groupMembership && method === 'DELETE') {
    const group = await getGroupById(db, groupMembership[1]);
    const member = await requireGroupAccess(db, group, user);
    if (group.is_personal) throw new ApiError(400, '系统个人群不能退出');
    if (group.owner_id === user.id || member.role === 'owner') throw new ApiError(400, '群主不能退出，请删除群组或转让群主');
    const removed = await db.remove('group_members', {
      id: `eq.${member.id}`,
      group_id: `eq.${group.id}`,
      user_id: `eq.${user.id}`,
    });
    if (!removed?.length) throw new ApiError(409, '成员状态已变化，请刷新后重试');
    return json({ ok: true, removed: member.id });
  }

  const groupMembers = pathname.match(/^\/api\/groups\/(\d+)\/members$/);
  if (groupMembers && method === 'GET') {
    const group = await getGroupById(db, groupMembers[1]);
    await requireGroupAccess(db, group, user);
    return json({ ok: true, group: await groupWithCount(db, group, user.id), members: await listMembers(db, group.id) });
  }

  if (pathname === '/api/foods' && method === 'GET') {
    const group = await resolveGroup(db, url, null, user);
    const member = await requireGroupAccess(db, group, user);
    return json({ ok: true, foods: await foodRowsForGroup(db, group.id, member.id), group: await groupWithCount(db, group, user.id) });
  }

  if (pathname === '/api/foods' && method === 'POST') {
    const body = await readBody(request);
    const food = normalizeFood(body);
    if (!food) throw new ApiError(400, '餐厅信息不正确');
    const group = await resolveGroup(db, url, body, user);
    await requireGroupAccess(db, group, user);
    const created = await db.insert('foods', { ...food, group_id: group.id });
    return json({ ok: true, food: created[0] }, 201);
  }

  const rating = pathname.match(/^\/api\/foods\/(\d+)\/rating$/);
  if (rating && method === 'POST') {
    const foodId = positiveId(rating[1]);
    const body = await readBody(request);
    const score = Number(body?.score);
    const group = await resolveGroup(db, url, body, user);
    const member = await requireGroupAccess(db, group, user);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new ApiError(400, '评分需要是 1-5 星');
    const foods = await db.list('foods', { select: 'id,imported_confirmed_count', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, '群里没有这个餐厅');
    await db.upsert('food_ratings', { food_id: foodId, member_id: member.id, score, updated_at: new Date().toISOString() }, 'food_id,member_id');
    const updated = (await foodRowsForGroup(db, group.id, member.id)).find((item) => item.id === foodId);
    return json({ ok: true, food: updated, member });
  }

  const visits = pathname.match(/^\/api\/foods\/(\d+)\/visits$/);
  if (visits && method === 'POST') {
    const foodId = positiveId(visits[1]);
    const body = await readBody(request);
    const group = await resolveGroup(db, url, body, user);
    const member = await requireGroupAccess(db, group, user);
    const foods = await db.list('foods', { select: 'id', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, '群里没有这个餐厅');
    await db.insert('food_visits', { food_id: foodId, member_id: member.id });
    const updated = (await foodRowsForGroup(db, group.id, member.id)).find((item) => item.id === foodId);
    return json({ ok: true, food: updated, member }, 201);
  }
  if (visits && method === 'DELETE') {
    const foodId = positiveId(visits[1]);
    const group = await resolveGroup(db, url, null, user);
    const member = await requireGroupAccess(db, group, user);
    const foods = await db.list('foods', { select: 'id,imported_confirmed_count', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, '群里没有这个餐厅');
    const latest = await db.list('food_visits', {
      select: 'id', food_id: `eq.${foodId}`, member_id: `eq.${member.id}`, order: 'id.desc', limit: 1,
    });
    if (latest[0]) {
      const removed = await db.remove('food_visits', { id: `eq.${latest[0].id}`, member_id: `eq.${member.id}` });
      if (!removed?.length) throw new ApiError(409, '这次到访已经被撤销');
    } else if (Number(foods[0].imported_confirmed_count) > 0) {
      await db.update('foods', { id: `eq.${foodId}`, group_id: `eq.${group.id}` }, {
        imported_confirmed_count: Number(foods[0].imported_confirmed_count) - 1,
        updated_at: new Date().toISOString(),
      });
    } else throw new ApiError(409, '没有可撤销的到访记录');
    const updated = (await foodRowsForGroup(db, group.id, member.id)).find((item) => item.id === foodId);
    return json({ ok: true, food: updated, member });
  }

  const deleteFood = pathname.match(/^\/api\/foods\/(\d+)$/);
  if (deleteFood && method === 'PATCH') {
    const foodId = positiveId(deleteFood[1]);
    const body = await readBody(request);
    const food = normalizeFood(body);
    const group = await resolveGroup(db, url, body, user);
    const member = await requireGroupAccess(db, group, user);
    if (!food) throw new ApiError(400, '餐厅信息不正确');
    const updated = await db.update('foods', { id: `eq.${foodId}`, group_id: `eq.${group.id}` }, {
      name: food.name,
      category: food.category,
      avg_price_yuan: food.avg_price_yuan,
      distance_m: food.distance_m,
      location_label: food.location_label,
      tags: food.tags,
      enabled: food.enabled,
      updated_at: new Date().toISOString(),
    });
    if (!updated?.length) throw new ApiError(404, '餐厅不存在');
    return json({ ok: true, food: updated[0] });
  }
  if (deleteFood && method === 'DELETE') {
    const foodId = positiveId(deleteFood[1]);
    const group = await resolveGroup(db, url, null, user);
    await requireGroupAccess(db, group, user);
    const removed = await db.remove('foods', { id: `eq.${foodId}`, group_id: `eq.${group.id}` });
    if (!removed?.length) throw new ApiError(404, '餐厅不存在');
    return json({ ok: true, removed: foodId });
  }

  if (pathname === '/api/foods/import' && method === 'POST') {
    const body = await readBody(request);
    const payload = importPayload(body);
    if (!payload) throw new ApiError(400, '需要餐厅数组或包含 restaurants 的 JSON');
    const group = await resolveGroup(db, url, null, user);
    const member = await requireGroupAccess(db, group, user);
    const next = payload.items.map(normalizeFood).filter(Boolean);
    if (!next.length) throw new ApiError(400, '没有可导入的数据');
    await db.rpc('replace_group_restaurants', {
      p_group_id: group.id,
      p_items: next,
      p_origin_name: payload.origin?.name ? String(payload.origin.name).trim() : null,
      p_origin_unit: payload.origin?.unit ? String(payload.origin.unit).trim() : 'm',
    });
    const foods = await foodRowsForGroup(db, group.id, member.id);
    return json({ ok: true, foods, total: foods.length, group: await groupWithCount(db, group, user.id) });
  }

  if (pathname === '/api/foods/export' && method === 'GET') {
    const group = await resolveGroup(db, url, null, user);
    const member = await requireGroupAccess(db, group, user);
    const foods = await foodRowsForGroup(db, group.id, member.id);
    return json({ ok: true, foods, exportedAt: new Date().toISOString(), total: foods.length, group: await groupWithCount(db, group, user.id) });
  }

  if (pathname === '/api/history' && method === 'GET') {
    const group = await resolveGroup(db, url, null, user);
    await requireGroupAccess(db, group, user);
    const rows = await db.list('meal_picks', {
      select: 'id,food_name,category,picked_at',
      group_id: `eq.${group.id}`,
      user_id: `eq.${user.id}`,
      order: 'picked_at.desc',
      limit: 50,
    });
    return json({ ok: true, history: rows });
  }

  if (pathname === '/api/history' && method === 'POST') {
    const body = await readBody(request);
    const foodId = positiveId(body?.foodId);
    const group = await resolveGroup(db, url, body, user);
    const member = await requireGroupAccess(db, group, user);
    const foods = await db.list('foods', { select: 'id,name,category', id: `eq.${foodId}`, group_id: `eq.${group.id}`, limit: 1 });
    if (!foods[0]) throw new ApiError(404, '群里没有这个餐厅');
    const created = await db.insert('meal_picks', {
      group_id: group.id,
      food_id: foodId,
      user_id: user.id,
      food_name: foods[0].name,
      category: foods[0].category || '未分类',
    });
    await db.insert('food_visits', { food_id: foodId, member_id: member.id });
    return json({ ok: true, item: created[0] }, 201);
  }

  if (pathname === '/api/history' && method === 'DELETE') {
    const group = await resolveGroup(db, url, null, user);
    await requireGroupAccess(db, group, user);
    await db.remove('meal_picks', { group_id: `eq.${group.id}`, user_id: `eq.${user.id}` });
    return json({ ok: true });
  }

  throw new ApiError(404, 'Not Found');
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    return await handleApi(context.request, context.env);
  } catch (error) {
    console.error('api request failed', error instanceof ApiError ? error.message : error);
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : '服务器暂时不可用';
    return json({ ok: false, msg: message }, status);
  }
}
