import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';

let onRequest;
const originalFetch = globalThis.fetch;
const env = {
  SUPABASE_URL: 'https://demo.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
};

before(async () => {
  const source = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  ({ onRequest } = await import(moduleUrl));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(path, init = {}) {
  return new Request(`https://today-eat-what.example${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

async function body(response) {
  return response.json();
}

test('protected routes reject requests without an authenticated cookie', async () => {
  globalThis.fetch = async () => {
    throw new Error('network should not be called');
  };

  const response = await onRequest({ request: request('/api/groups'), env });
  assert.equal(response.status, 401);
  assert.deepEqual(await body(response), { ok: false, msg: '请先登录' });
});

test('login keeps Supabase tokens out of JSON and writes HttpOnly secure cookies', async () => {
  const internalEmail = `${createHash('sha256').update('小夏').digest('hex')}@users.today-eat-what.invalid`;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.deepEqual(JSON.parse(init.body), { email: internalEmail, password: 'password123' });
    return Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      user: { id: 'user-a', email: internalEmail, user_metadata: { username: '小夏', display_name: '小夏' } },
    });
  };

  const response = await onRequest({
    request: request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: '小夏', password: 'password123' }),
    }),
    env,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    user: { id: 'user-a', email: '', username: '小夏', display_name: '小夏' },
  });
  const cookieHeader = response.headers.get('set-cookie') || '';
  assert.match(cookieHeader, /wte_access_token=access-token/);
  assert.match(cookieHeader, /wte_refresh_token=refresh-token/);
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /Secure/);
  assert.doesNotMatch(cookieHeader, /SameSite=None/);
});

test('invalid login input is rejected before any upstream request', async () => {
  globalThis.fetch = async () => {
    throw new Error('network should not be called');
  };
  const response = await onRequest({
    request: request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: '', password: '' }) }),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { ok: false, msg: '请输入用户名和密码' });
});

test('signup creates a confirmed user with the secret key and immediately signs in', async () => {
  const internalEmail = `${createHash('sha256').update('alice').digest('hex')}@users.today-eat-what.invalid`;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    call += 1;
    if (call === 1) {
      assert.equal(String(url), 'https://demo.supabase.co/auth/v1/admin/users');
      assert.equal(init.headers.apikey, env.SUPABASE_SECRET_KEY);
      assert.equal(init.headers.Authorization, `Bearer ${env.SUPABASE_SECRET_KEY}`);
      assert.deepEqual(JSON.parse(init.body), {
        email: internalEmail,
        password: 'password123',
        email_confirm: true,
        user_metadata: { username: 'Alice', display_name: 'Alice' },
      });
      return Response.json({ id: 'new-user', email: internalEmail });
    }
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.deepEqual(JSON.parse(init.body), { email: internalEmail, password: 'password123' });
    return Response.json({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      user: { id: 'new-user', email: internalEmail, user_metadata: { username: 'Alice', display_name: 'Alice' } },
    });
  };
  const response = await onRequest({
    request: request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'Alice', password: 'password123' }),
    }),
    env,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await body(response), {
    ok: true,
    user: { id: 'new-user', email: '', username: 'Alice', display_name: 'Alice' },
  });
  const cookieHeader = response.headers.get('set-cookie') || '';
  assert.match(cookieHeader, /wte_access_token=new-access/);
  assert.match(cookieHeader, /wte_refresh_token=new-refresh/);
  assert.equal(call, 2);
});

test('retrying signup after a partial failure signs in the already-created user', async () => {
  const internalEmail = `${createHash('sha256').update('alice').digest('hex')}@users.today-eat-what.invalid`;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    call += 1;
    if (call === 1) {
      assert.equal(String(url), 'https://demo.supabase.co/auth/v1/admin/users');
      return Response.json({ message: 'A user with this email address has already been registered' }, { status: 422 });
    }
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(init.body), { email: internalEmail, password: 'password123' });
    return Response.json({
      access_token: 'recovered-access',
      refresh_token: 'recovered-refresh',
      expires_in: 3600,
      user: { id: 'new-user', email: internalEmail, user_metadata: { username: 'Alice', display_name: 'Alice' } },
    });
  };
  const response = await onRequest({
    request: request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'Alice', password: 'password123' }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal((await body(response)).user.username, 'Alice');
  assert.equal(call, 2);
});

test('legacy email accounts can still sign in during migration', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    assert.deepEqual(JSON.parse(init.body), { email: 'alice@example.com', password: 'password123' });
    return Response.json({
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expires_in: 3600,
      user: { id: 'legacy-user', email: 'alice@example.com', user_metadata: { display_name: 'Alice' } },
    });
  };
  const response = await onRequest({
    request: request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'Alice@Example.com', password: 'password123' }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    user: { id: 'legacy-user', email: 'alice@example.com', username: '', display_name: 'Alice' },
  });
});

test('a signed-in user cannot read members of a group they did not join', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?')) {
      return Response.json([{ id: 2, name: 'Bob group', code: 'BOB123', owner_id: 'user-b', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2/members', { headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), { ok: false, msg: '你还没有加入这个群' });
});

test('a group owner can delete a custom group', async () => {
  let deleteCalled = false;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?') && init.method !== 'DELETE') {
      return Response.json([{ id: 2, name: 'Lunch', code: 'LUNCH2', owner_id: 'user-a', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([{ id: 9, group_id: 2, user_id: 'user-a', name: 'Alice', role: 'owner' }]);
    }
    if (target.includes('/rest/v1/groups?') && init.method === 'DELETE') {
      deleteCalled = true;
      assert.match(target, /owner_id=eq\.user-a/);
      assert.match(target, /is_personal=eq\.false/);
      return Response.json([{ id: 2 }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2', { method: 'DELETE', headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(deleteCalled, true);
  assert.deepEqual(await body(response), { ok: true, removed: 2 });
});

test('a regular member cannot delete a group owned by someone else', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?') && init.method !== 'DELETE') {
      return Response.json([{ id: 2, name: 'Bob group', code: 'BOB123', owner_id: 'user-b', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([{ id: 9, group_id: 2, user_id: 'user-a', name: 'Alice', role: 'member' }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2', { method: 'DELETE', headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), { ok: false, msg: '只有群主可以删除这个群' });
});

test('the automatic personal group cannot be deleted', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?') && init.method !== 'DELETE') {
      return Response.json([{ id: 1, name: 'My group', code: 'MINE01', owner_id: 'user-a', is_personal: true }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([{ id: 1, group_id: 1, user_id: 'user-a', name: 'Alice', role: 'owner' }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/1', { method: 'DELETE', headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { ok: false, msg: '系统个人群不能删除' });
});

test('an owner can rename their automatic personal group', async () => {
  let patchCalled = false;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?') && init.method !== 'PATCH') {
      return Response.json([{ id: 1, name: 'My group', code: 'MINE01', owner_id: 'user-a', is_personal: true }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([{ id: 1, group_id: 1, user_id: 'user-a', name: 'Alice', role: 'owner' }]);
    }
    if (target.includes('/rest/v1/groups?') && init.method === 'PATCH') {
      patchCalled = true;
      assert.match(target, /owner_id=eq\.user-a/);
      assert.deepEqual(JSON.parse(init.body), { name: '独享午餐' });
      return Response.json([{ id: 1, name: '独享午餐', code: 'MINE01', owner_id: 'user-a', is_personal: true }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/1', {
      method: 'PATCH', headers: { Cookie: 'wte_access_token=user-a-token' }, body: JSON.stringify({ name: '独享午餐' }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(patchCalled, true);
  const payload = await body(response);
  assert.equal(payload.group.name, '独享午餐');
  assert.equal(payload.group.is_personal, true);
});

test('a regular member cannot rename a group', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?') && init.method !== 'PATCH') {
      return Response.json([{ id: 2, name: 'Bob group', code: 'BOB123', owner_id: 'user-b', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?')) {
      return Response.json([{ id: 9, group_id: 2, user_id: 'user-a', name: 'Alice', role: 'member' }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2', {
      method: 'PATCH', headers: { Cookie: 'wte_access_token=user-a-token' }, body: JSON.stringify({ name: 'Not mine' }),
    }),
    env,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), { ok: false, msg: '只有群主可以修改群名' });
});

test('a regular member can leave a custom group', async () => {
  let deleteCalled = false;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?')) {
      return Response.json([{ id: 2, name: 'Bob group', code: 'BOB123', owner_id: 'user-b', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?') && init.method !== 'DELETE') {
      return Response.json([{ id: 9, group_id: 2, user_id: 'user-a', name: 'Alice', role: 'member' }]);
    }
    if (target.includes('/rest/v1/group_members?') && init.method === 'DELETE') {
      deleteCalled = true;
      assert.match(target, /user_id=eq\.user-a/);
      return Response.json([{ id: 9 }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2/membership', { method: 'DELETE', headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(deleteCalled, true);
  assert.deepEqual(await body(response), { ok: true, removed: 9 });
});

test('a group owner cannot leave without deleting or transferring the group', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === 'https://demo.supabase.co/auth/v1/user') {
      return Response.json({ id: 'user-a', email: 'alice@example.com', user_metadata: {} });
    }
    if (target.includes('/rest/v1/groups?')) {
      return Response.json([{ id: 2, name: 'Lunch', code: 'LUNCH2', owner_id: 'user-a', is_personal: false }]);
    }
    if (target.includes('/rest/v1/group_members?') && init.method !== 'DELETE') {
      return Response.json([{ id: 9, group_id: 2, user_id: 'user-a', name: 'Alice', role: 'owner' }]);
    }
    throw new Error(`unexpected request: ${target}`);
  };

  const response = await onRequest({
    request: request('/api/groups/2/membership', { method: 'DELETE', headers: { Cookie: 'wte_access_token=user-a-token' } }),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { ok: false, msg: '群主不能退出，请删除群组或转让群主' });
});
