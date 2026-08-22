const API_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:3000' : location.origin;
const IS_LOCAL = location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);
const GROUP_KEY = 'wte-current-group-v3';
const HISTORY_KEY = 'wte-history-v2';
const MEMBER_TOKEN_KEY = 'wte-member-token-v1';
const MEMBER_NAME_KEY = 'wte-member-name-v1';

let groups = [];
let foods = [];
let members = [];
let historyItems = [];
let currentGroupId = null;
let currentUser = null;
let authMode = 'login';
let isPicking = false;
let groupMenuId = null;
let groupMenuPlacement = null;
let renameGroupId = null;

const memberToken = localStorage.getItem(MEMBER_TOKEN_KEY)
  || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(16).slice(2)}`);
localStorage.setItem(MEMBER_TOKEN_KEY, memberToken);
const memberName = localStorage.getItem(MEMBER_NAME_KEY) || `搭子${memberToken.replace(/-/g, '').slice(-4)}`;
localStorage.setItem(MEMBER_NAME_KEY, memberName);

const $ = (id) => document.getElementById(id);
const els = {
  authGate: $('authGate'), authName: $('authName'), authEmail: $('authEmail'), authPassword: $('authPassword'),
  authSubmit: $('authSubmit'), authStatus: $('authStatus'), loginTab: $('loginTab'), signupTab: $('signupTab'),
  accountBtn: $('accountBtn'), accountBackdrop: $('accountBackdrop'), accountName: $('accountName'), accountEmail: $('accountEmail'),
  accountStatus: $('accountStatus'), groupOpenBtn: $('groupOpenBtn'), groupBackdrop: $('groupBackdrop'), groupList: $('groupList'),
  groupStatus: $('groupStatus'), currentGroupTitle: $('currentGroupTitle'), currentGroupCode: $('currentGroupCode'),
  currentMemberCount: $('currentMemberCount'), memberSummary: $('memberSummary'), currentGroupMenu: $('currentGroupMenu'),
  memberList: $('memberList'), result: $('result'), dice: $('dice'), countTip: $('countTip'), listWrap: $('listWrap'),
  listLen: $('listLen'), importStatus: $('importStatus'), search: $('searchInput'), category: $('categorySelect'),
  rankList: $('rankList'), mealTotal: $('mealTotal'), pickTotal: $('pickTotal'), historyList: $('historyList'),
};

function setStatus(element, text, type = '') {
  element.textContent = text || '';
  element.className = `status ${type}`;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function queryUrl(path) {
  const [pathname, queryText = ''] = path.split('?');
  const query = new URLSearchParams(queryText);
  if (!pathname.startsWith('/api/auth/')) {
    if (currentGroupId) query.set('groupId', String(currentGroupId));
    if (IS_LOCAL) query.set('memberToken', memberToken);
  }
  const text = query.toString();
  return `${API_BASE}${pathname}${text ? `?${text}` : ''}`;
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.msg || `请求失败（${response.status}）`);
  return payload;
}

async function authCall(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return parseResponse(response);
}

async function api(path, options = {}, canRefresh = true) {
  const response = await fetch(queryUrl(path), {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401 && !IS_LOCAL && canRefresh && !path.startsWith('/api/auth/')) {
    try {
      await authCall('/api/auth/refresh', { method: 'POST' });
      return api(path, options, false);
    } catch {
      showAuthGate('登录已过期，请重新登录');
    }
  }
  return parseResponse(response);
}

function memberPayload(extra = {}) {
  return IS_LOCAL ? { memberToken, memberName, ...extra } : extra;
}

function currentGroup() {
  return groups.find((group) => group.id === Number(currentGroupId)) || groups[0];
}

function updateAccountUI() {
  if (!currentUser) return;
  els.accountName.textContent = currentUser.display_name || '吃饭搭子';
  els.accountEmail.textContent = currentUser.email || (IS_LOCAL ? '本机演示模式' : '');
  els.accountBtn.textContent = (currentUser.display_name || '我').slice(0, 1).toUpperCase();
}

function switchAuth(mode) {
  authMode = mode;
  const signingUp = mode === 'signup';
  els.loginTab.classList.toggle('active', !signingUp);
  els.signupTab.classList.toggle('active', signingUp);
  els.authName.style.display = signingUp ? 'block' : 'none';
  els.authName.required = signingUp;
  els.authPassword.autocomplete = signingUp ? 'new-password' : 'current-password';
  els.authSubmit.textContent = signingUp ? '注册并登录' : '登录';
  setStatus(els.authStatus, '');
}

function showAuthGate(message = '') {
  currentUser = null;
  els.authGate.classList.remove('hidden');
  switchAuth('login');
  if (message) setStatus(els.authStatus, message, 'warn');
}

async function adoptHashSession() {
  if (!location.hash.includes('access_token=')) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  const data = await authCall('/api/auth/adopt-session', {
    method: 'POST',
    body: JSON.stringify({ accessToken, refreshToken, expiresIn: Number(params.get('expires_in')) || 3600 }),
  });
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return data;
}

async function finishLogin(user) {
  currentUser = user;
  updateAccountUI();
  els.authGate.classList.add('hidden');
  groups = [];
  foods = [];
  members = [];
  historyItems = [];
  currentGroupId = null;
  await loadGroups();
  handleInviteCode();
}

async function initializeAuth() {
  if (IS_LOCAL) {
    await finishLogin({ display_name: memberName, email: '本机演示模式' });
    return;
  }
  try {
    const adopted = await adoptHashSession();
    if (adopted?.user) {
      await finishLogin(adopted.user);
      return;
    }
  } catch (error) {
    setStatus(els.authStatus, error.message, 'fail');
  }
  try {
    const data = await authCall('/api/auth/session');
    await finishLogin(data.user);
  } catch {
    try {
      const refreshed = await authCall('/api/auth/refresh', { method: 'POST' });
      await finishLogin(refreshed.user);
    } catch {
      showAuthGate();
    }
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  const displayName = els.authName.value.trim();
  els.authSubmit.disabled = true;
  setStatus(els.authStatus, authMode === 'signup' ? '正在创建账号…' : '正在登录…');
  try {
    const data = await authCall(authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(authMode === 'signup' ? { displayName } : {}) }),
    });
    if (data.needs_confirmation) {
      switchAuth('login');
      els.authEmail.value = email;
      setStatus(els.authStatus, '注册成功，请先打开验证邮件，再回来登录。', 'ok');
      return;
    }
    await finishLogin(data.user);
  } catch (error) {
    setStatus(els.authStatus, error.message, 'fail');
  } finally {
    els.authSubmit.disabled = false;
  }
}

async function logout() {
  if (IS_LOCAL) {
    setStatus(els.accountStatus, '本机演示模式没有远程账号。', 'warn');
    return;
  }
  try { await authCall('/api/auth/logout', { method: 'POST' }); } catch {}
  els.accountBackdrop.classList.remove('open');
  showAuthGate('已退出登录');
}

async function loadGroups(selectId) {
  const data = await api('/api/groups');
  groups = data.groups || [];
  const cached = Number(localStorage.getItem(GROUP_KEY));
  const target = groups.find((group) => group.id === Number(selectId))
    || groups.find((group) => group.id === cached)
    || groups[0];
  if (target) await setGroup(target.id, false);
  renderGroupList();
}

async function ensureMembership() {
  if (!IS_LOCAL || !currentGroupId) return null;
  return api(`/api/groups/${currentGroupId}/join`, {
    method: 'POST', body: JSON.stringify(memberPayload()),
  });
}

async function loadMembers() {
  if (!currentGroupId) return;
  const groupId = currentGroupId;
  try {
    const data = await api(`/api/groups/${groupId}/members`);
    if (currentGroupId !== groupId) return;
    members = data.members || [];
  } catch {
    if (currentGroupId !== groupId) return;
    members = [];
  }
  renderMembers();
}

function renderMembers() {
  els.memberSummary.textContent = `${members.length} 位成员`;
  els.currentMemberCount.textContent = `${members.length} 位成员`;
  els.memberList.innerHTML = members.map((member, index) => {
    const name = member.name || `群成员 ${index + 1}`;
    const role = member.role === 'owner' ? ' · 群主' : '';
    return `<div class="member-row"><span>${esc(name)}${role}</span><small>${Number(member.rating_count) || 0} 次评分 · ${Number(member.visit_count) || 0} 次到访</small></div>`;
  }).join('') || '<div class="member-row"><span>还没有群成员</span></div>';
}

function updateInviteCard(group) {
  if (!group) return;
  els.currentGroupTitle.textContent = group.name;
  els.currentGroupCode.textContent = group.code;
  els.currentMemberCount.textContent = `${Number(group.member_count) || members.length} 位成员`;
  $('currentGroupMenuBtn').hidden = !groupMenuAvailable(group);
  renderCurrentGroupMenu();
}

async function setGroup(id, announce = true) {
  const target = groups.find((group) => group.id === Number(id));
  if (!target) return;
  currentGroupId = target.id;
  groupMenuId = null;
  groupMenuPlacement = null;
  localStorage.setItem(GROUP_KEY, String(currentGroupId));
  els.groupOpenBtn.textContent = `${target.name} · ${target.code}`;
  $('foodGroupTip').textContent = target.name;
  $('statsGroupTip').textContent = target.name;
  updateInviteCard(target);
  await ensureMembership();
  if (currentGroupId !== target.id) return;
  await Promise.all([loadFoods(), loadMembers(), loadHistory()]);
  renderGroupList();
  if (announce) {
    els.groupBackdrop.classList.remove('open');
    setStatus(els.groupStatus, `已切换到「${target.name}」`, 'ok');
  }
}

function renderGroupList() {
  els.groupList.innerHTML = groups.map((group) => {
    const type = group.is_personal ? '个人群' : `${Number(group.member_count) || 0} 位成员`;
    const menu = groupMenuPlacement === 'list' && groupMenuId === group.id ? groupActionMenu(group) : '';
    const menuButton = groupMenuAvailable(group) ? `<button class="group-menu-trigger list-menu" data-group-menu="${group.id}" aria-label="${esc(group.name)}的操作">···</button>` : '';
    return `<div class="group-option ${group.id === currentGroupId ? 'current' : ''}"><button class="group-switch" data-group-id="${group.id}"><span class="group-symbol">群</span><span class="group-copy"><strong>${esc(group.name)}</strong><small>${esc(group.code)} · ${type}</small></span>${group.id === currentGroupId ? '<span class="check">✓</span>' : ''}</button>${menuButton}${menu}</div>`;
  }).join('') || '<div class="empty">还没有群组</div>';
  els.groupList.querySelectorAll('[data-group-id]').forEach((button) => {
    button.onclick = () => setGroup(Number(button.dataset.groupId));
  });
  els.groupList.querySelectorAll('[data-group-menu]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      toggleGroupMenu(Number(button.dataset.groupMenu), 'list');
    };
  });
  bindGroupActions(els.groupList);
}

function groupMenuAvailable(group) {
  return !IS_LOCAL && Boolean(group && (group.is_owner || !group.is_personal));
}

function groupActionMenu(group) {
  if (!groupMenuAvailable(group)) return '';
  const rename = group.is_owner ? `<button data-group-action="rename" data-action-group="${group.id}">✎ 修改群名</button>` : '';
  const remove = group.is_owner && !group.is_personal
    ? `<button class="danger" data-group-action="delete" data-action-group="${group.id}">⌫ 删除群组</button>`
    : (!group.is_owner && !group.is_personal ? `<button class="danger" data-group-action="leave" data-action-group="${group.id}">↪ 退出群组</button>` : '');
  return `<div class="group-action-menu">${rename}${remove}</div>`;
}

function bindGroupActions(root) {
  root.querySelectorAll('[data-group-action]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const id = Number(button.dataset.actionGroup);
      if (button.dataset.groupAction === 'rename') openRenameGroup(id);
      if (button.dataset.groupAction === 'delete') deleteGroup(id);
      if (button.dataset.groupAction === 'leave') leaveGroup(id);
    };
  });
}

function renderCurrentGroupMenu() {
  const group = currentGroup();
  els.currentGroupMenu.innerHTML = groupMenuPlacement === 'current' && groupMenuId === group?.id ? groupActionMenu(group) : '';
  bindGroupActions(els.currentGroupMenu);
}

function toggleGroupMenu(id, placement) {
  const sameMenu = groupMenuId === id && groupMenuPlacement === placement;
  groupMenuId = sameMenu ? null : id;
  groupMenuPlacement = sameMenu ? null : placement;
  renderCurrentGroupMenu();
  renderGroupList();
}

async function loadFoods() {
  const groupId = currentGroupId;
  try {
    const data = await api('/api/foods');
    if (currentGroupId !== groupId) return;
    foods = data.foods || [];
    renderFoods();
    updateStats();
    setStatus(els.importStatus, `已同步 ${foods.length} 条群组餐厅数据`, 'ok');
  } catch (error) {
    if (currentGroupId !== groupId) return;
    foods = [];
    renderFoods();
    setStatus(els.importStatus, error.message || '数据库连接失败', 'fail');
  }
}

function renderFoods() {
  const keyword = (els.search.value || '').trim().toLowerCase();
  const selectedCategory = els.category.value;
  const categories = [...new Set(foods.map((food) => food.category || '未分类'))];
  els.category.innerHTML = '<option value="">全部类型</option>' + categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  els.category.value = selectedCategory;
  const rows = foods.filter((food) => (!keyword || food.name.toLowerCase().includes(keyword)) && (!selectedCategory || food.category === selectedCategory));
  els.listLen.textContent = `(${foods.length})`;
  els.listWrap.innerHTML = rows.length ? rows.map((food) => {
    const rating = Number(food.rating) || 0;
    const ratings = Number(food.rating_count) || 0;
    const visits = Number(food.visit_count) || 0;
    const myRating = Number(food.my_rating) || 0;
    const featured = rating >= 4 || visits >= 2;
    return `<article class="restaurant-card"><div class="r-top"><div><div class="restaurant-name">${esc(food.name)} ${featured ? '<span class="tag featured">群精选</span>' : ''}</div><div class="meta">📁 ${esc(food.category || '未分类')}　⭐ ${rating ? rating.toFixed(1) : '暂无'}　👥 ${ratings} 人评分</div></div><div class="r-actions"><button class="outline-btn" data-pick="${food.id}">抽选</button><button class="danger-btn" data-del="${food.id}">删除</button></div></div><div class="rating-row"><div class="stars" aria-label="给${esc(food.name)}评分">${[1, 2, 3, 4, 5].map((score) => `<button class="star ${score <= myRating ? 'selected' : ''}" data-rate="${food.id}" data-score="${score}" aria-label="${score}星">★</button>`).join('')}</div><span class="rating-copy">我的评分 ${myRating ? `${myRating} 星` : '未评分'}</span></div><div class="card-foot"><span class="tag">${esc(food.category || '未分类')}</span><button class="visit-btn" data-visit="${food.id}">✓ 去过一次 · 共 ${visits} 次</button></div></article>`;
  }).join('') : '<div class="empty">还没有餐厅，先添加一个吧～</div>';
  els.listWrap.querySelectorAll('[data-pick]').forEach((button) => { button.onclick = () => pickOne(Number(button.dataset.pick)); });
  els.listWrap.querySelectorAll('[data-del]').forEach((button) => { button.onclick = () => deleteFood(Number(button.dataset.del)); });
  els.listWrap.querySelectorAll('[data-rate]').forEach((button) => { button.onclick = () => rateFood(Number(button.dataset.rate), Number(button.dataset.score)); });
  els.listWrap.querySelectorAll('[data-visit]').forEach((button) => { button.onclick = () => recordVisit(Number(button.dataset.visit)); });
}

async function rateFood(id, score) {
  try {
    await api(`/api/foods/${id}/rating`, { method: 'POST', body: JSON.stringify(memberPayload({ score })) });
    await Promise.all([loadFoods(), loadMembers()]);
    setStatus(els.importStatus, `已提交 ${score} 星评分，群友都能看到`, 'ok');
  } catch (error) { setStatus(els.importStatus, error.message || '评分失败，请重试', 'fail'); }
}

async function recordVisit(id) {
  try {
    await api(`/api/foods/${id}/visits`, { method: 'POST', body: JSON.stringify(memberPayload()) });
    await Promise.all([loadFoods(), loadMembers()]);
    setStatus(els.importStatus, '已记录去过一次，群组到访次数已更新', 'ok');
  } catch (error) { setStatus(els.importStatus, error.message || '记录到访失败，请重试', 'fail'); }
}

function localGroupHistory() {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    return Array.isArray(all[currentGroupId]) ? all[currentGroupId] : [];
  } catch { return []; }
}

function saveLocalHistory(items) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch {}
  all[currentGroupId] = items.slice(0, 50);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}

async function loadHistory() {
  if (!currentGroupId) return;
  if (IS_LOCAL) {
    historyItems = localGroupHistory();
  } else {
    const data = await api('/api/history');
    historyItems = data.history || [];
  }
  renderHistory();
}

function pickOne(id) {
  if (isPicking) return;
  if (!foods.length) {
    els.result.textContent = '当前群还没有餐厅，请先添加';
    els.result.classList.remove('highlight');
    return;
  }
  const food = id ? foods.find((item) => item.id === id) : foods[Math.floor(Math.random() * foods.length)];
  if (!food) return;
  isPicking = true;
  document.querySelectorAll('.pick-main,.quick').forEach((button) => { button.disabled = true; });
  els.groupOpenBtn.disabled = true;
  els.accountBtn.disabled = true;
  els.dice.classList.remove('rolling');
  void els.dice.offsetWidth;
  els.dice.classList.add('rolling');
  els.result.classList.remove('highlight');
  els.result.textContent = '正在摇骰子…';
  els.countTip.textContent = `${foods.length} 个选项随机中`;
  let dots = 0;
  const ticker = setInterval(() => {
    dots = (dots + 1) % 4;
    els.result.textContent = `正在摇骰子${'.'.repeat(dots)}`;
  }, 150);
  setTimeout(async () => {
    clearInterval(ticker);
    els.dice.classList.remove('rolling');
    els.result.textContent = `今天就吃：${food.name}`;
    els.result.classList.add('highlight');
    els.countTip.textContent = `${food.category || '未分类'} · 来自「${currentGroup()?.name || '当前群'}」`;
    try {
      if (IS_LOCAL) {
        const next = localGroupHistory();
        next.unshift({ name: food.name, category: food.category || '未分类', at: new Date().toISOString() });
        saveLocalHistory(next);
      } else {
        await api('/api/history', { method: 'POST', body: JSON.stringify({ foodId: food.id }) });
      }
      await loadHistory();
    } catch (error) {
      setStatus(els.importStatus, `结果已选出，但历史保存失败：${error.message}`, 'warn');
    }
    updateStats();
    isPicking = false;
    document.querySelectorAll('.pick-main,.quick').forEach((button) => { button.disabled = false; });
    els.groupOpenBtn.disabled = false;
    els.accountBtn.disabled = false;
  }, 2050);
}

async function addFood() {
  const name = $('nameInput').value.trim();
  const category = $('catInput').value.trim() || '未分类';
  if (!name) { setStatus(els.importStatus, '请输入名称', 'warn'); return; }
  try {
    await api('/api/foods', { method: 'POST', body: JSON.stringify({ name, category }) });
    $('nameInput').value = '';
    $('catInput').value = '';
    $('addPanel').style.display = 'none';
    await loadFoods();
  } catch (error) { setStatus(els.importStatus, error.message || '添加失败', 'fail'); }
}

async function deleteFood(id) {
  try { await api(`/api/foods/${id}`, { method: 'DELETE' }); await loadFoods(); }
  catch (error) { setStatus(els.importStatus, error.message || '删除失败', 'fail'); }
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(',').map((item) => item.trim().toLowerCase());
  const hasHead = head.includes('name');
  return (hasHead ? lines.slice(1) : lines).map((line) => {
    const values = line.split(',').map((item) => item.trim());
    const name = hasHead ? values[head.indexOf('name')] : values[0];
    if (!name) return null;
    return { name, category: hasHead ? (values[head.indexOf('category')] || '未分类') : (values[1] || '未分类') };
  }).filter(Boolean);
}

async function importFile() {
  const file = $('fileInput').files?.[0];
  if (!file) { setStatus(els.importStatus, '请先选择文件', 'warn'); return; }
  try {
    const text = await file.text();
    let next = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseCSV(text);
    if (!Array.isArray(next) || !next.length) throw new Error('文件中没有数据');
    next = next.map((item) => typeof item === 'string' ? { name: item, category: '未分类' } : item).filter((item) => item?.name);
    await api('/api/foods/import', { method: 'POST', body: JSON.stringify(next) });
    await loadFoods();
    setStatus(els.importStatus, `已导入 ${next.length} 条`, 'ok');
  } catch (error) { setStatus(els.importStatus, error.message || '导入失败，请检查 JSON/CSV 格式', 'fail'); }
}

async function exportFile() {
  try {
    const data = await api('/api/foods/export');
    const blob = new Blob([JSON.stringify(data.foods || [], null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `foods-${currentGroupId}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  } catch (error) { setStatus(els.importStatus, error.message || '导出失败', 'fail'); }
}

function updateStats() {
  els.mealTotal.textContent = foods.length;
  els.pickTotal.textContent = foods.reduce((sum, food) => sum + (Number(food.visit_count) || 0), 0);
  const rows = foods.filter((food) => Number(food.rating) || Number(food.visit_count)).slice()
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || (Number(b.visit_count) || 0) - (Number(a.visit_count) || 0)).slice(0, 5);
  els.rankList.innerHTML = rows.length ? rows.map((food) => `<div class="rank"><span>${esc(food.name)}</span><b>⭐ ${Number(food.rating) ? Number(food.rating).toFixed(1) : '暂无'} · ${Number(food.visit_count) || 0} 次</b></div>`).join('') : '<div class="empty" style="padding:12px 0">群里还没有评分或到访记录</div>';
}

function renderHistory() {
  els.historyList.innerHTML = historyItems.length ? historyItems.map((item) => {
    const name = item.food_name || item.name;
    const time = item.picked_at || item.at;
    return `<div class="history-item"><div><strong>${esc(name)}</strong><small style="display:block;margin-top:4px">${esc(item.category || '未分类')}</small></div><small>${new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div>`;
  }).join('') : '<div class="empty">还没有历史记录</div>';
}

async function clearHistory() {
  try {
    if (IS_LOCAL) saveLocalHistory([]);
    else await api('/api/history', { method: 'DELETE' });
    await loadHistory();
  } catch (error) { setStatus(els.importStatus, error.message || '清空失败', 'fail'); }
}

function showView(view) {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.target === view));
  if (view === 'stats') updateStats();
  if (view === 'history') renderHistory();
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); setStatus(els.groupStatus, message, 'ok'); }
  catch { setStatus(els.groupStatus, '复制失败，请长按群码手动复制', 'warn'); }
}

function copyCode() {
  const group = currentGroup();
  if (group) copyText(group.code, '群码已复制，可以发给吃饭搭子。');
}

function copyInvite() {
  const group = currentGroup();
  if (!group) return;
  const linkBase = IS_LOCAL ? 'http://localhost:3000' : location.origin;
  copyText(`来加入「${group.name}」一起吃饭吧！打开 ${linkBase}/?groupCode=${encodeURIComponent(group.code)}，登录后加入群。`, '邀请文案已复制。');
}

async function createGroup() {
  const name = $('newGroupName').value.trim();
  const code = $('newGroupCode').value.trim();
  if (!name) { setStatus(els.groupStatus, '群名不能为空', 'warn'); return; }
  try {
    const data = await api('/api/groups', { method: 'POST', body: JSON.stringify(memberPayload({ name, ...(code ? { code } : {}) })) });
    $('newGroupName').value = '';
    $('newGroupCode').value = '';
    $('createGroupForm').hidden = true;
    await loadGroups(data.group.id);
    setStatus(els.groupStatus, `已创建「${data.group.name}」，群码：${data.group.code}`, 'ok');
  } catch (error) { setStatus(els.groupStatus, error.message || '创建失败', 'fail'); }
}

async function joinGroup() {
  const code = $('joinCode').value.trim();
  if (!code) { setStatus(els.groupStatus, '请输入群码', 'warn'); return; }
  try {
    const data = await api('/api/groups/join-by-code', { method: 'POST', body: JSON.stringify(memberPayload({ groupCode: code })) });
    $('joinCode').value = '';
    $('joinGroupForm').hidden = true;
    await loadGroups(data.group.id);
    setStatus(els.groupStatus, `已加入「${data.group.name}」`, 'ok');
  } catch (error) { setStatus(els.groupStatus, error.message || '没有找到这个群码，或加入失败', 'fail'); }
}

function openRenameGroup(id) {
  const group = groups.find((item) => item.id === Number(id));
  if (!group?.is_owner) return;
  renameGroupId = group.id;
  groupMenuId = null;
  groupMenuPlacement = null;
  $('renameGroupInput').value = group.name;
  setStatus($('renameGroupStatus'), '');
  $('renameGroupBackdrop').classList.add('open');
  $('renameGroupInput').focus();
  renderCurrentGroupMenu();
  renderGroupList();
}

function closeRenameGroup() {
  renameGroupId = null;
  $('renameGroupBackdrop').classList.remove('open');
}

async function saveRenameGroup() {
  const group = groups.find((item) => item.id === Number(renameGroupId));
  const name = $('renameGroupInput').value.trim();
  if (!group?.is_owner) { closeRenameGroup(); return; }
  if (!name) { setStatus($('renameGroupStatus'), '群名不能为空', 'warn'); return; }
  if (name.length > 50) { setStatus($('renameGroupStatus'), '群名不能超过 50 个字', 'warn'); return; }
  setStatus($('renameGroupStatus'), '正在保存…');
  try {
    const data = await api(`/api/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    closeRenameGroup();
    await loadGroups(data.group.id);
    setStatus(els.groupStatus, `已修改为「${data.group.name}」`, 'ok');
  } catch (error) {
    setStatus($('renameGroupStatus'), error.message || '修改群名失败', 'fail');
  }
}

async function leaveGroup(id) {
  const group = groups.find((item) => item.id === Number(id));
  if (!group || group.is_owner || group.is_personal) return;
  if (!confirm(`确定退出「${group.name}」吗？退出后将无法再查看这个群的餐厅和记录。`)) return;
  setStatus(els.groupStatus, `正在退出「${group.name}」…`);
  try {
    await api(`/api/groups/${group.id}/membership`, { method: 'DELETE' });
    groupMenuId = null;
    groupMenuPlacement = null;
    await loadGroups();
    setStatus(els.groupStatus, `已退出「${group.name}」`, 'ok');
  } catch (error) {
    setStatus(els.groupStatus, error.message || '退出群组失败', 'fail');
  }
}

async function deleteGroup(id) {
  const group = groups.find((item) => item.id === Number(id));
  if (!group || !group.is_owner || group.is_personal) return;
  if (!confirm(`确定删除「${group.name}」吗？群内餐厅、评分、到访和历史记录都会一起删除，且无法恢复。`)) return;
  setStatus(els.groupStatus, `正在删除「${group.name}」…`);
  try {
    await api(`/api/groups/${group.id}`, { method: 'DELETE' });
    await loadGroups();
    setStatus(els.groupStatus, `已删除「${group.name}」`, 'ok');
  } catch (error) {
    setStatus(els.groupStatus, error.message || '删除群组失败', 'fail');
  }
}

function handleInviteCode() {
  const inviteCode = new URLSearchParams(location.search).get('groupCode');
  if (!inviteCode) return;
  $('joinCode').value = inviteCode;
  els.groupBackdrop.classList.add('open');
  $('joinGroupForm').hidden = false;
  $('createGroupForm').hidden = true;
  setStatus(els.groupStatus, '确认群码后点击“加入群”。', 'warn');
}

document.querySelectorAll('.nav-btn').forEach((button) => { button.onclick = () => showView(button.dataset.target); });
$('authForm').onsubmit = submitAuth;
els.loginTab.onclick = () => switchAuth('login');
els.signupTab.onclick = () => switchAuth('signup');
$('pickBtn').onclick = () => pickOne();
$('quickPickBtn').onclick = () => pickOne();
$('rerollBtn').onclick = () => pickOne();
$('doneBtn').onclick = () => { if (els.result.classList.contains('highlight')) setStatus(els.importStatus, '已记录到账号历史', 'ok'); };
$('showAddBtn').onclick = () => { const panel = $('addPanel'); panel.style.display = panel.style.display === 'none' ? 'grid' : 'none'; };
$('addBtn').onclick = addFood;
$('importBtn').onclick = importFile;
$('exportBtn').onclick = exportFile;
els.search.oninput = renderFoods;
els.category.onchange = renderFoods;
els.groupOpenBtn.onclick = () => { els.groupBackdrop.classList.add('open'); renderGroupList(); renderCurrentGroupMenu(); loadMembers(); };
$('closeGroupBtn').onclick = () => els.groupBackdrop.classList.remove('open');
els.groupBackdrop.onclick = (event) => { if (event.target === els.groupBackdrop) els.groupBackdrop.classList.remove('open'); };
els.accountBtn.onclick = () => { updateAccountUI(); els.accountBackdrop.classList.add('open'); };
$('closeAccountBtn').onclick = () => els.accountBackdrop.classList.remove('open');
els.accountBackdrop.onclick = (event) => { if (event.target === els.accountBackdrop) els.accountBackdrop.classList.remove('open'); };
$('logoutBtn').onclick = logout;
$('currentGroupMenuBtn').onclick = () => { const group = currentGroup(); if (group) toggleGroupMenu(group.id, 'current'); };
$('copyCodeBtn').onclick = copyCode;
$('inviteBtn').onclick = copyInvite;
$('memberToggleBtn').onclick = () => {
  const open = els.memberList.hidden;
  els.memberList.hidden = !open;
  $('memberToggleBtn').classList.toggle('open', open);
};
$('showCreateGroupBtn').onclick = () => {
  $('createGroupForm').hidden = !$('createGroupForm').hidden;
  $('joinGroupForm').hidden = true;
};
$('showJoinGroupBtn').onclick = () => {
  $('joinGroupForm').hidden = !$('joinGroupForm').hidden;
  $('createGroupForm').hidden = true;
};
$('createGroupBtn').onclick = createGroup;
$('joinGroupBtn').onclick = joinGroup;
$('cancelRenameGroupBtn').onclick = closeRenameGroup;
$('saveRenameGroupBtn').onclick = saveRenameGroup;
$('renameGroupBackdrop').onclick = (event) => { if (event.target === $('renameGroupBackdrop')) closeRenameGroup(); };
$('renameGroupInput').onkeydown = (event) => { if (event.key === 'Enter') saveRenameGroup(); };
$('clearHistoryBtn').onclick = clearHistory;
$('helpBtn').onclick = () => alert('登录后，每个账号只会看到自己创建或加入的吃饭群。同群成员共享餐厅、评分和到访数据；抽选历史属于当前账号。');

initializeAuth().catch((error) => {
  console.error(error);
  showAuthGate(error.message || '初始化失败，请刷新重试');
});
