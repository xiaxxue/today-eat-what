const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  if (!process.argv[2]) throw new Error('请传入要导入的餐厅 JSON 文件路径');
  const packagePath = path.resolve(process.argv[2]);
  const groupCode = process.argv[3] || 'default';
  const db = new DatabaseSync(path.resolve('foods.db'), { readOnly: true });

  const group = db.prepare('SELECT id, name, code FROM groups WHERE code = ?').get(groupCode);
  if (!group) throw new Error(`找不到群码为 ${groupCode} 的群`);
  const member = db.prepare('SELECT token FROM group_members WHERE group_id = ? AND token IS NOT NULL ORDER BY id LIMIT 1').get(group.id);
  db.close();
  if (!member?.token) throw new Error('当前群没有可用的本地成员身份');

  const payload = JSON.parse(await readFile(packagePath, 'utf8'));
  if (!Array.isArray(payload?.restaurants) || !payload.restaurants.length) throw new Error('导入包中没有餐厅数据');

  const query = new URLSearchParams({ groupId: String(group.id), memberToken: member.token });
  const response = await fetch(`http://127.0.0.1:3000/api/foods/import?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.msg || `导入失败（${response.status}）`);

  console.log(`已将 ${result.total} 家餐厅写入「${group.name}」`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
