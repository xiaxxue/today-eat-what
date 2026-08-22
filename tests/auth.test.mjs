import assert from 'node:assert/strict';
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
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.deepEqual(JSON.parse(init.body), { email: 'alice@example.com', password: 'password123' });
    return Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      user: { id: 'user-a', email: 'alice@example.com', user_metadata: { display_name: 'Alice' } },
    });
  };

  const response = await onRequest({
    request: request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'Alice@Example.com', password: 'password123' }),
    }),
    env,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    user: { id: 'user-a', email: 'alice@example.com', display_name: 'Alice' },
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
    request: request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: '', password: '' }) }),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { ok: false, msg: '请输入邮箱和密码' });
});

test('email confirmation adoption exchanges the refresh token for a verified session', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://demo.supabase.co/auth/v1/token?grant_type=refresh_token');
    assert.deepEqual(JSON.parse(init.body), { refresh_token: 'confirmation-refresh' });
    return Response.json({
      access_token: 'verified-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      user: { id: 'verified-user', email: 'verified@example.com', user_metadata: {} },
    });
  };
  const response = await onRequest({
    request: request('/api/auth/adopt-session', {
      method: 'POST',
      body: JSON.stringify({ accessToken: 'untrusted-access', refreshToken: 'confirmation-refresh' }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  const cookieHeader = response.headers.get('set-cookie') || '';
  assert.match(cookieHeader, /wte_access_token=verified-access/);
  assert.match(cookieHeader, /wte_refresh_token=rotated-refresh/);
  assert.doesNotMatch(cookieHeader, /untrusted-access/);
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
