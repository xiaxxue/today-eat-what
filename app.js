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
let selectedFoodId = null;
let selectedFoodConfirmed = false;
let editingFoodId = null;

const memberToken = IS_LOCAL ? 'local-owner' : (localStorage.getItem(MEMBER_TOKEN_KEY)
  || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `member-${Date.now()}-${Math.random().toString(16).slice(2)}`));
localStorage.setItem(MEMBER_TOKEN_KEY, memberToken);
const memberName = IS_LOCAL ? '我' : (localStorage.getItem(MEMBER_NAME_KEY) || `搭子${memberToken.replace(/-/g, '').slice(-4)}`);
localStorage.setItem(MEMBER_NAME_KEY, memberName);

const $ = (id) => document.getElementById(id);
const locationField = document.createElement('div');
locationField.className = 'restaurant-field full';
locationField.innerHTML = '<label for="locationInput">地点 / 商圈</label><input class="input" id="locationInput" maxlength="50" placeholder="如：西溪银泰、龙湖天街" />';
$('catInput').closest('.restaurant-field').before(locationField);
const els = {
  authGate: $('authGate'), authUsername: $('authUsername'), authPassword: $('authPassword'),
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

async function request(path, options = {}) {
  try {
    return await fetch(path, options);
  } catch (error) {
    if (IS_LOCAL) {
      throw new Error('本地服务未启动，请先运行 npm start，再打开 http://localhost:3000');
    }
    throw error;
  }
}

async function authCall(path, options = {}) {
  const response = await request(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return parseResponse(response);
}

async function api(path, options = {}, canRefresh = true) {
  const response = await request(queryUrl(path), {
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
  els.accountEmail.textContent = currentUser.username ? `@${currentUser.username}` : (currentUser.email || (IS_LOCAL ? '本机演示模式' : ''));
  els.accountBtn.textContent = (currentUser.display_name || '我').slice(0, 1).toUpperCase();
}

function switchAuth(mode) {
  authMode = mode;
  const signingUp = mode === 'signup';
  els.loginTab.classList.toggle('active', !signingUp);
  els.signupTab.classList.toggle('active', signingUp);
  els.authUsername.placeholder = signingUp ? '用户名（2-24 位）' : '用户名（旧账号也可输入邮箱）';
  els.authUsername.maxLength = signingUp ? 24 : 50;
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
    try {
      await finishLogin({ display_name: memberName, email: '本机演示模式' });
    } catch (error) {
      showAuthGate(error.message);
    }
    return;
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
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;
  els.authSubmit.disabled = true;
  setStatus(els.authStatus, authMode === 'signup' ? '正在创建账号…' : '正在登录…');
  try {
    const data = await authCall(authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
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
  selectedFoodId = null;
  selectedFoodConfirmed = false;
  isPicking = false;
  els.result.textContent = '点击“随机一家”决定今天去哪家餐厅';
  els.result.classList.remove('highlight');
  els.countTip.textContent = '';
  updatePickUI();
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
  const rows = foods.filter((food) => {
    const searchableText = [
      food.name,
      food.category,
      ...(Array.isArray(food.tags) ? food.tags : []),
      restaurantLocationLabel(food),
    ].filter(Boolean).join(' ').toLowerCase();
    return (!keyword || searchableText.includes(keyword)) && (!selectedCategory || food.category === selectedCategory);
  });
  els.listLen.textContent = `(${foods.length})`;
  els.listWrap.innerHTML = rows.length ? rows.map((food) => {
    const rating = Number(food.rating) || 0;
    const ratings = Number(food.rating_count) || 0;
    const visits = Number(food.visit_count) || 0;
    const myVisits = Number(food.my_visit_count) || 0;
    const myRating = Number(food.my_rating) || 0;
    const price = food.avg_price_yuan !== null && food.avg_price_yuan !== undefined && Number.isFinite(Number(food.avg_price_yuan)) ? `💰 ¥${Number(food.avg_price_yuan)}` : '';
    const distance = food.distance_m !== null && food.distance_m !== undefined && Number.isFinite(Number(food.distance_m)) ? `📍 ${formatDistance(Number(food.distance_m))}` : '';
    const tags = Array.isArray(food.tags) ? food.tags : [];
    const locationLabel = restaurantLocationLabel(food);
    const featured = rating >= 4 || visits >= 2;
    const meta = [`📁 ${esc(food.category || '未分类')}`, price, distance].filter(Boolean).join('　');
    return `<article class="restaurant-card ${food.enabled === false ? 'disabled' : ''}"><div class="r-top"><div><div class="restaurant-name">${esc(food.name)} ${locationLabel ? `<span class="tag location-tag">📍 ${esc(locationLabel)}</span>` : ''}${featured ? '<span class="tag featured">群精选</span>' : ''}${food.enabled === false ? '<span class="tag">已停用</span>' : ''}</div><div class="meta">${meta}</div>${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div><div class="r-actions"><button class="select-btn" data-pick="${food.id}" ${food.enabled === false ? 'disabled' : ''}>选这家</button><details class="card-menu"><summary aria-label="${esc(food.name)}更多操作">···</summary><div class="card-menu-popover"><button data-edit="${food.id}">编辑餐厅</button><button class="danger" data-del="${food.id}">删除餐厅</button></div></details></div></div><div class="rating-row"><div class="stars" aria-label="给${esc(food.name)}评分">${[1, 2, 3, 4, 5].map((score) => `<button class="star ${score <= myRating ? 'selected' : ''}" data-rate="${food.id}" data-score="${score}" aria-label="${score}星">★</button>`).join('')}</div><span class="rating-copy">我的评分 ${myRating ? `${myRating} 星` : '未评分'}</span></div><div class="card-foot"><span class="rating-copy">⭐ ${rating ? rating.toFixed(1) : '暂无'} · ${ratings} 人评分</span><div class="visit-action"><span>我去过</span><div class="visit-stepper"><button data-visit-minus="${food.id}" aria-label="撤销${esc(food.name)}的一次到访" ${myVisits === 0 ? 'disabled' : ''}>−</button><strong>${myVisits}</strong><button data-visit-plus="${food.id}" aria-label="记录${esc(food.name)}的一次到访">＋</button></div><span>次</span></div></div></article>`;
  }).join('') : `<div class="empty">${keyword || selectedCategory ? '没有找到匹配的餐厅' : '还没有餐厅，先添加一个吧～'}</div>`;
  els.listWrap.querySelectorAll('[data-pick]').forEach((button) => { button.onclick = () => selectFood(Number(button.dataset.pick)); });
  els.listWrap.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => startEditFood(Number(button.dataset.edit)); });
  els.listWrap.querySelectorAll('[data-del]').forEach((button) => { button.onclick = () => deleteFood(Number(button.dataset.del)); });
  els.listWrap.querySelectorAll('[data-rate]').forEach((button) => { button.onclick = () => rateFood(Number(button.dataset.rate), Number(button.dataset.score)); });
  els.listWrap.querySelectorAll('[data-visit-plus]').forEach((button) => { button.onclick = () => recordVisit(Number(button.dataset.visitPlus)); });
  els.listWrap.querySelectorAll('[data-visit-minus]').forEach((button) => { button.onclick = () => undoVisit(Number(button.dataset.visitMinus)); });
}

function formatDistance(distanceM) {
  return distanceM < 1000 ? `${distanceM}m` : `${(distanceM / 1000).toFixed(distanceM % 1000 === 0 ? 0 : 1)}km`;
}

function restaurantLocationLabel(food) {
  const explicitLabel = String(food.location_label || food.locationLabel || '').trim();
  if (explicitLabel) return explicitLabel;
  const name = String(food.name || '');
  const tags = Array.isArray(food.tags) ? food.tags.map(String) : [];
  const distance = Number(food.distance_m);
  if (/龙湖.*天街|西溪天街/.test(name) || tags.some((tag) => /^天街/.test(tag)) || distance === 613) return '龙湖天街';
  if (/西溪银泰|银泰城/.test(name) || tags.some((tag) => /^银泰城/.test(tag)) || distance === 383) return '西溪银泰';
  if (/西溪谷/.test(name) || tags.some((tag) => /^G座内$/.test(tag))) return '西溪谷';
  return '';
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

async function undoVisit(id) {
  try {
    await api(`/api/foods/${id}/visits`, { method: 'DELETE' });
    await Promise.all([loadFoods(), loadMembers()]);
    setStatus(els.importStatus, '已撤销一次到访记录', 'ok');
  } catch (error) { setStatus(els.importStatus, error.message || '撤销到访失败，请重试', 'fail'); }
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

function updatePickUI() {
  const hasSelection = Boolean(selectedFoodId);
  const pickButton = $('pickBtn');
  const decisionActions = $('decisionActions');
  const doneButton = $('doneBtn');
  const chip = $('resultStatusChip');
  pickButton.hidden = hasSelection;
  decisionActions.hidden = !hasSelection;
  chip.hidden = !hasSelection;
  if (!hasSelection) {
    pickButton.textContent = isPicking ? '🎲 正在抽选…' : '🎲 随机一家';
    pickButton.disabled = isPicking;
    $('decisionHelper').textContent = '';
    $('decisionHelper').className = 'decision-helper';
    return;
  }
  $('rerollBtn').disabled = isPicking;
  doneButton.disabled = isPicking || selectedFoodConfirmed;
  doneButton.textContent = selectedFoodConfirmed ? '✓ 已记录' : '就吃这家';
  doneButton.classList.remove('loading');
  doneButton.classList.toggle('confirmed', selectedFoodConfirmed);
  chip.textContent = selectedFoodConfirmed ? '已记录' : '待确认';
  chip.classList.toggle('confirmed', selectedFoodConfirmed);
  $('decisionHelper').textContent = selectedFoodConfirmed ? '已记录到历史，可以换一家继续抽选' : '确认后会记录到历史';
  $('decisionHelper').className = `decision-helper${selectedFoodConfirmed ? ' ok' : ''}`;
}

function selectFood(id) {
  if (isPicking) return;
  const food = foods.find((item) => Number(item.id) === Number(id) && item.enabled !== false);
  if (!food) return;
  selectedFoodId = food.id;
  selectedFoodConfirmed = false;
  els.dice.classList.remove('rolling');
  els.result.textContent = `今天去这家：${food.name}`;
  els.result.classList.add('highlight');
  els.countTip.textContent = `已手动选择 · ${food.category || '未分类'} · 来自「${currentGroup()?.name || '当前群'}」`;
  updatePickUI();
  showView('pick');
  document.querySelector('.content').scrollTop = 0;
}

function pickOne() {
  if (isPicking) return;
  const pickableFoods = foods.filter((food) => food.enabled !== false);
  if (!pickableFoods.length) {
    els.result.textContent = '当前群还没有餐厅，请先添加';
    els.result.classList.remove('highlight');
    return;
  }
  const food = pickableFoods[Math.floor(Math.random() * pickableFoods.length)];
  if (!food) return;
  selectedFoodId = null;
  selectedFoodConfirmed = false;
  isPicking = true;
  updatePickUI();
  els.groupOpenBtn.disabled = true;
  els.accountBtn.disabled = true;
  els.dice.classList.remove('rolling');
  void els.dice.offsetWidth;
  els.dice.classList.add('rolling');
  els.result.classList.remove('highlight');
  els.result.textContent = '正在摇骰子…';
  els.countTip.textContent = `${pickableFoods.length} 家餐厅随机中`;
  let dots = 0;
  const ticker = setInterval(() => {
    dots = (dots + 1) % 4;
    els.result.textContent = `正在摇骰子${'.'.repeat(dots)}`;
  }, 150);
  setTimeout(async () => {
    clearInterval(ticker);
    els.dice.classList.remove('rolling');
    els.result.textContent = `今天去这家：${food.name}`;
    els.result.classList.add('highlight');
    els.countTip.textContent = `${food.category || '未分类'} · 来自「${currentGroup()?.name || '当前群'}」`;
    selectedFoodId = food.id;
    updateStats();
    isPicking = false;
    updatePickUI();
    els.groupOpenBtn.disabled = false;
    els.accountBtn.disabled = false;
  }, 2050);
}

async function confirmSelectedFood() {
  if (!selectedFoodId || selectedFoodConfirmed) return;
  const food = foods.find((item) => Number(item.id) === Number(selectedFoodId));
  if (!food) return;
  $('doneBtn').disabled = true;
  $('doneBtn').classList.add('loading');
  $('doneBtn').textContent = '正在记录…';
  $('decisionHelper').textContent = '正在写入历史记录';
  try {
    if (IS_LOCAL) {
      await api(`/api/foods/${food.id}/confirm`, { method: 'POST', body: JSON.stringify(memberPayload()) });
      const next = localGroupHistory();
      next.unshift({ name: food.name, category: food.category || '未分类', at: new Date().toISOString() });
      saveLocalHistory(next);
    } else {
      await api('/api/history', { method: 'POST', body: JSON.stringify({ foodId: food.id }) });
    }
    selectedFoodConfirmed = true;
    await Promise.all([loadFoods(), loadHistory()]);
    updatePickUI();
    setStatus(els.importStatus, `已确定去「${food.name}」`, 'ok');
  } catch (error) {
    selectedFoodConfirmed = false;
    updatePickUI();
    $('decisionHelper').textContent = error.message || '记录失败，请重试';
    $('decisionHelper').className = 'decision-helper fail';
    setStatus(els.importStatus, error.message || '确认失败', 'fail');
  }
}

function resetFoodForm() {
  editingFoodId = null;
  $('foodFormTitle').textContent = '新增餐厅';
  $('addBtn').textContent = '保存到当前群';
  $('nameInput').value = '';
  $('catInput').value = '';
  $('locationInput').value = '';
  $('priceInput').value = '';
  $('distanceInput').value = '';
  $('tagsInput').value = '';
  $('enabledInput').checked = true;
}

function closeFoodForm() {
  resetFoodForm();
  $('addPanel').style.display = 'none';
}

function runFoodSearch(scrollToResults = false) {
  if ($('addPanel').style.display !== 'none') closeFoodForm();
  renderFoods();
  if (scrollToResults) els.listWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startEditFood(id) {
  const food = foods.find((item) => Number(item.id) === Number(id));
  if (!food) return;
  editingFoodId = Number(id);
  $('foodFormTitle').textContent = '编辑餐厅';
  $('addBtn').textContent = '保存修改';
  $('nameInput').value = food.name || '';
  $('catInput').value = food.category || '';
  $('locationInput').value = food.location_label || restaurantLocationLabel(food) || '';
  $('priceInput').value = food.avg_price_yuan ?? '';
  $('distanceInput').value = food.distance_m ?? '';
  $('tagsInput').value = Array.isArray(food.tags) ? food.tags.join('，') : '';
  $('enabledInput').checked = food.enabled !== false;
  $('addPanel').style.display = 'grid';
  $('addPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus(els.importStatus, `正在编辑「${food.name}」`, 'warn');
}

async function addFood() {
  const name = $('nameInput').value.trim();
  const category = $('catInput').value.trim();
  const locationLabel = $('locationInput').value.trim();
  const priceText = $('priceInput').value.trim();
  const distanceText = $('distanceInput').value.trim();
  const avgPriceYuan = priceText === '' ? null : Number(priceText);
  const distanceM = distanceText === '' ? null : Number(distanceText);
  const tags = [...new Set($('tagsInput').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
  const enabled = $('enabledInput').checked;
  if (!name) { setStatus(els.importStatus, '请输入名称', 'warn'); return; }
  if (!category) { setStatus(els.importStatus, '请输入餐厅类型', 'warn'); return; }
  if ((avgPriceYuan !== null && !Number.isInteger(avgPriceYuan)) || avgPriceYuan < 0) { setStatus(els.importStatus, '人均价格需要是大于等于 0 的整数', 'warn'); return; }
  if ((distanceM !== null && !Number.isInteger(distanceM)) || distanceM < 0) { setStatus(els.importStatus, '距离需要是大于等于 0 的整数', 'warn'); return; }
  try {
    const editingId = editingFoodId;
    const path = editingId ? `/api/foods/${editingId}` : '/api/foods';
    await api(path, { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify({ name, category, location_label: locationLabel || null, avg_price_yuan: avgPriceYuan, distance_m: distanceM, tags, enabled, source: 'manual' }) });
    closeFoodForm();
    await loadFoods();
    setStatus(els.importStatus, editingId ? `已保存「${name}」的修改` : `已添加「${name}」`, 'ok');
  } catch (error) { setStatus(els.importStatus, error.message || (editingFoodId ? '保存失败' : '添加失败'), 'fail'); }
}

async function deleteFood(id) {
  const food = foods.find((item) => Number(item.id) === Number(id));
  if (!food || !globalThis.confirm(`确定删除「${food.name}」吗？\n评分和去过记录也会一起删除。`)) return;
  try {
    await api(`/api/foods/${id}`, { method: 'DELETE' });
    if (Number(editingFoodId) === Number(id)) closeFoodForm();
    await loadFoods();
    setStatus(els.importStatus, `已删除「${food.name}」`, 'ok');
  }
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
    const parsed = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseCSV(text);
    const rawItems = Array.isArray(parsed) ? parsed : parsed?.restaurants;
    if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('文件中没有餐厅数据');
    const validItems = rawItems.map((item) => typeof item === 'string' ? { name: item, category: '未分类' } : item).filter((item) => item?.name);
    if (!confirm(`将用 ${validItems.length} 家餐厅替换「${currentGroup()?.name || '当前群'}」的餐厅库。群和成员会保留，旧餐厅数据将被清除。是否继续？`)) return;
    const payload = Array.isArray(parsed) ? validItems : { ...parsed, restaurants: validItems };
    await api('/api/foods/import', { method: 'POST', body: JSON.stringify(payload) });
    await loadFoods();
    setStatus(els.importStatus, `已替换为 ${validItems.length} 家餐厅`, 'ok');
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
  els.pickTotal.textContent = foods.reduce((sum, food) => sum + (Number(food.confirmed_count) || 0), 0);
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
$('rerollBtn').onclick = () => pickOne();
$('doneBtn').onclick = confirmSelectedFood;
$('showAddBtn').onclick = () => {
  const panel = $('addPanel');
  if (panel.style.display === 'none') {
    resetFoodForm();
    panel.style.display = 'grid';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else closeFoodForm();
};
$('addBtn').onclick = addFood;
$('cancelFoodBtn').onclick = closeFoodForm;
$('importBtn').onclick = importFile;
$('exportBtn').onclick = exportFile;
els.search.oninput = () => runFoodSearch(false);
$('searchBtn').onclick = () => runFoodSearch(true);
els.category.onchange = () => runFoodSearch(true);
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
