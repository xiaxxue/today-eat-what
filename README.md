# 今天吃什么？H5

一个支持吃饭群、群组餐厅、评分、到访和随机抽选的移动端 H5。

- 本地开发：Node.js + SQLite
- 线上部署：Cloudflare Pages Functions + Supabase Postgres

## 一、启动服务

```bash
npm start
```

默认监听：`http://localhost:3000`

## 二、打开页面

请用浏览器访问：

- `http://localhost:3000`

然后把这个地址发给局域网其他设备即可共享数据库（同一份数据）。

## 三、项目结构

- `server.js`：Node 后端（使用 `node:sqlite` 持久化）
- `index.html`：前端页面
- `foods.db`：运行时自动创建的 SQLite 文件（首次启动时自动建库并塞入默认菜品）
- `functions/api/[[path]].js`：Cloudflare Pages Functions 后端 API
- `supabase/schema.sql`：Supabase 建表、索引、RLS 和初始数据
- `build-static.js`：生成 Cloudflare Pages 的 `dist/` 静态目录

## 四、群组（吃饭群 / 搭子）说明

- 默认会有一个「默认吃饭群」。
- 你可以在页面里创建新群，设置群名和可选群码。
- 每个群有独立餐厅列表、成员、评分和到访记录，所有设备共享同一套后端数据库。
- 要加入已有群，输入群码即可；未加入的群不会出现在群组列表中。
- 每位成员可给餐厅打 1–5 星，也可点击「去过一次」累计群组到访次数。
- 餐厅按群组平均评分、到访次数排序，评分达到 4 星或累计到访 2 次会显示「群精选」。
- 当前版本使用浏览器生成的成员标识，不需要注册账号；群码相当于加入凭证。页面只展示“群成员 1/2…”及贡献概况，不把昵称作为群管理入口。

## 五、最快启动（推荐）

### 方式一（推荐）
```bash
cd "/Users/didi/Documents/ChatGPT/今天吃什么？"
./start-local.sh
```

### 方式二
```bash
cd "/Users/didi/Documents/ChatGPT/今天吃什么？"
npm start
```

服务启动后访问：
- `http://127.0.0.1:3000`
- 如果 3000 被占用，改成别的端口：`PORT=3002 ./start-local.sh`

## 六、Cloudflare Pages + Supabase 部署

### 1. 初始化 Supabase

1. 在 Supabase 创建一个项目。
2. 打开 `SQL Editor`。
3. 完整执行 `supabase/schema.sql`。

表已经启用 RLS，浏览器不能直接读写；线上请求统一经过 Cloudflare Pages Functions。

### 2. 创建 Cloudflare Pages 项目

连接 GitHub 仓库，并填写：

```text
Build command: npm run build
Build output directory: dist
Root directory: /
```

Cloudflare 会自动识别 `functions/` 目录，并将 `/api/*` 交给 Pages Functions。

### 3. 配置后端环境变量

在 Cloudflare Pages 项目的 `Settings > Variables and Secrets` 中配置：

```text
SUPABASE_URL=https://你的项目.supabase.co
SUPABASE_SECRET_KEY=你的 Supabase secret key
```

如果项目仍使用旧版 JWT key，也可以用：

```text
SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
```

`SUPABASE_SECRET_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY` 必须保存为 Secret，不能放进前端、GitHub 或普通环境变量。

### 4. 部署验证

重新部署后检查：

- `/api/health` 返回 `database: "supabase"` 和 `initialized: true`
- 首页可以加载默认餐厅
- 可以创建吃饭群并生成群码
- 另一台设备可以通过群码加入
- 评分和“去过一次”刷新后仍然保留

## 七、当前成员身份说明

当前 Demo 使用浏览器生成的随机成员 token，不要求注册登录。Supabase Auth 还没有启用；以后需要账号登录、换设备识别同一用户时，再接入 Supabase Auth。
