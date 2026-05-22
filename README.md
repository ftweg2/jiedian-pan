# Wangpan

个人文件分享中转站 + 重要照片和文档存储系统。推荐部署形态是：

- 主 VPS：运行 Web、API、PostgreSQL，以及一个本地 storage-agent。
- 远端 storage-agent VPS：只运行 storage-agent，用来保存额外副本。
- 当前优先使用同机房、同内网或安全私网 IP。跨云厂商 VPS 建议先用 WireGuard 组成统一私有网络，再把 agent 地址配置为 WireGuard IP。

## 组成

- `apps/api`：主服务，负责登录、权限、文件索引、应用层加密、分享链接、版本历史、访问记录、副本调度和后台清理。
- `apps/storage-agent`：轻量存储节点，只保存密文对象，提供写入、读取、删除、hash 校验和磁盘状态。
- `apps/web`：React 管理工作台和公开分享下载页。
- `packages/shared`：共享类型、权限和策略函数。
- `packages/storage-driver`：存储驱动接口、`AgentStorageDriver`，以及未来预留的 `S3StorageDriver`。当前部署不使用 S3/Garage。

## 主 VPS 从零部署

### 1. 前置条件

在主 VPS 安装：

- Docker Engine
- Docker Compose plugin，命令形式为 `docker compose`
- `openssl`
- 一个域名和反向代理/TLS 方案，正式公网使用时建议准备。只在内网或临时公网 IP 测试时可以先用 HTTP。

拉取或复制项目代码到主 VPS 后，进入仓库根目录。

### 2. 创建主 VPS `.env`

复制示例：

```bash
cp .env.example .env
```

生成密钥：

```bash
openssl rand -base64 32   # APP_MASTER_KEY，必须解码为 32 字节
openssl rand -base64 48   # COOKIE_SECRET
openssl rand -base64 32   # POSTGRES_PASSWORD 或 LOCAL_AGENT_TOKEN
```

至少填写主 VPS 部分：

- `APP_MASTER_KEY`：文件内容加密主密钥。当前 API 读取的变量名是 `APP_MASTER_KEY`，不是 `MASTER_KEY`。它必须能解码为恰好 32 字节：推荐 `openssl rand -base64 32`，也接受 64 字符 hex。必须长期保存，丢失后已上传文件无法解密。
- `COOKIE_SECRET`：登录 cookie 签名密钥。
- `POSTGRES_PASSWORD`：PostgreSQL 密码。
- `CORS_ORIGIN`：Web 外部访问地址，例如 `https://pan.example.com`。
- `PUBLIC_BASE_URL`：公开分享链接的外部基准地址，例如 `https://pan.example.com`。
- `MAX_UPLOAD_BYTES`：单次上传明文大小上限，默认 `536870912`。
- `SESSION_TTL_DAYS`：登录 session 有效期，默认 `14`。
- `COOKIE_SECURE`：HTTPS 正式部署设为 `true`。纯 HTTP 测试时设为 `false`。
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`：首次启动时创建第一个管理员。只有数据库里还没有用户时才会生效。
- `BOOTSTRAP_LOCAL_NODE_*` 和 `LOCAL_AGENT_TOKEN`：自动注册主 VPS 本地 storage-agent。

如果不使用 `docker-compose.main.yml` 直接运行 API 进程，还必须设置：

- `DATABASE_URL`：PostgreSQL 连接串，例如 `postgresql://wangpan:<password>@127.0.0.1:5432/wangpan`。
- `PORT` / `HOST`：默认 `4000` / `0.0.0.0`。

Compose 部署时 `DATABASE_URL` 会由 `POSTGRES_PASSWORD` 自动拼出；`.env.example` 中的 standalone `DATABASE_URL` 行仅供非 compose 部署参考。

### 3. 构建并启动

推荐用脚本，它会固定读取仓库根目录的 `.env`：

```bash
./scripts/compose-main.sh up -d --build
```

等价原始命令：

```bash
docker compose --env-file .env -f docker-compose.main.yml up -d --build
```

API 镜像启动命令会先执行：

```bash
npx prisma migrate deploy
```

因此正常启动会自动完成数据库迁移。需要手工检查日志时：

```bash
./scripts/compose-main.sh logs -f api
./scripts/compose-main.sh ps
```

### 4. 首次登录和本地节点

打开 `PUBLIC_BASE_URL` 或主 VPS `http://<主机>:8080`，用 `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` 登录。

首次启动会按 `BOOTSTRAP_LOCAL_NODE_URL` 和 `BOOTSTRAP_LOCAL_NODE_TOKEN` 自动注册本地 agent。默认 compose 内部地址是：

```text
http://storage-agent-local:4010
```

在 Web 管理后台的“节点”页应能看到本地节点健康状态。

### 5. 反向代理和 TLS

`docker-compose.main.yml` 对外暴露：

- Web：`8080`
- API：`4000`

Web 容器内的 nginx 会把 `/api/` 反代到 API。常见正式部署方式是让宿主机上的 Caddy、Nginx 或 Traefik 终止 TLS，并反代到 `127.0.0.1:8080`。配置 HTTPS 后：

- `PUBLIC_BASE_URL=https://你的域名`
- `CORS_ORIGIN=https://你的域名`
- `COOKIE_SECURE=true`

如果直接公开 API 或 agent 端口，请自行配置防火墙、TLS 或 WireGuard。

## 远端 storage-agent VPS 从零部署

每台远端 VPS 只需要运行 `docker-compose.agent.yml`。

### 1. 前置条件

在远端 storage-agent VPS 安装：

- Docker Engine
- Docker Compose plugin
- `openssl`

复制同一份仓库代码到该 VPS，进入仓库根目录。

### 2. 创建 agent `.env`

可以从 `.env.example` 只复制“Remote storage-agent VPS”部分到该 VPS 的 `.env`：

```env
NODE_ID=remote-vps-1
AGENT_TOKEN=replace-with-at-least-24-random-chars
AGENT_MAX_OBJECT_BYTES=1073741824
```

建议：

- `NODE_ID` 使用稳定唯一值，例如 `remote-vps-1`、`home-nas-1`。
- `AGENT_TOKEN` 使用长随机值，并只告诉主 API。生成示例：`openssl rand -base64 32`。
- `AGENT_DATA_DIR` 在 compose 中固定为容器内 `/data/objects`，由 Docker volume `agent-data` 持久化。非 compose 直接运行 agent 时可设置 `AGENT_DATA_DIR`；代码默认值是 `./data/objects`。需要使用宿主机目录时，可以把 compose volume 改成绑定挂载，例如 `/srv/wangpan-agent:/data/objects`。
- `AGENT_MAX_OBJECT_BYTES` 是单个对象请求体上限，默认 1 GiB。

### 3. 启动 agent

```bash
./scripts/compose-agent.sh up -d --build
```

等价原始命令：

```bash
docker compose --env-file .env -f docker-compose.agent.yml up -d --build
```

健康检查：

```bash
curl http://127.0.0.1:4010/health
curl -H "Authorization: Bearer $AGENT_TOKEN" http://127.0.0.1:4010/status
```

`/health` 不需要 token，`/status` 和对象读写都需要 Bearer Token。

### 4. 在主站添加远端节点

在主站 Web 管理后台进入“节点”，添加：

- 名称：例如 `remote-vps-1`
- Base URL：主 API 能访问到的 agent 地址，例如 `http://10.0.0.2:4010`
- Agent Token：远端 `.env` 中的 `AGENT_TOKEN`

当前推荐同一 LAN、VPC、内网互通地址或 WireGuard IP。跨厂商公网 HTTP 直连不推荐。

## 网络模式

当前建议：

- 主 VPS 和远端 agent 在同一 LAN/VPC 时，使用私有 IP，例如 `http://10.0.0.2:4010`。
- 跨云厂商、跨地域或家庭网络时，先用 WireGuard 组网，再在节点 Base URL 中填写 WireGuard 私网 IP。
- 如果必须跨公网直连 agent，请至少使用 TLS 和防火墙限制来源 IP。

后续可以把跨厂商 VPS 全部接入 WireGuard 统一私有网络，主 API 只访问 WireGuard 地址。

## 安全边界

重要事实：

- 文件内容在 API 写入 storage-agent 之前已经做应用层加密。storage-agent 磁盘上保存的是密文对象，不保存明文。
- storage-agent 不知道 `APP_MASTER_KEY`，也不负责解密文件。`APP_MASTER_KEY` 只在 API 中用于 envelope encryption，实际每个文件/分片使用独立 file key。
- storage-agent 使用 Bearer Token 鉴权。请把 token 当作写入、读取、删除密文对象的高权限 secret。
- API 会把 agent token 存在 storage node 记录里，用它调用 storage-agent；`/nodes`、文件详情和节点健康响应不会回显 `agentToken`。
- HTTP 传输是否加密取决于你的网络配置。项目不会自动给 agent 到 API 的链路加 TLS。
- 同一私网内可以先用 HTTP；跨公网或跨供应商链路应使用 WireGuard 或 TLS。WireGuard/TLS 是传输层保护，和应用层加密是两层独立防线。
- 分享链接只存 token hash，可选密码只存 password hash。

`APP_MASTER_KEY` 是最高价值 secret。泄露会降低内容加密安全性，丢失会导致已上传文件无法恢复明文。

## 备份和恢复

必须同时备份 PostgreSQL 和 `APP_MASTER_KEY`。

PostgreSQL 备份包含：

- 用户、会话、权限
- 文件索引
- 分享链接和访问日志
- 版本历史
- 副本、chunk 和节点元数据

`APP_MASTER_KEY` 用于解密所有文件内容。只备份 storage-agent 密文对象而没有 `APP_MASTER_KEY`，无法恢复文件明文。只备份对象和 master key 但丢失数据库，也会丢失索引、版本、分享、权限和副本定位信息，恢复会非常困难。

示例 PostgreSQL 备份：

```bash
./scripts/compose-main.sh exec -T postgres pg_dump -U wangpan -d wangpan > wangpan-$(date +%F).sql
```

示例恢复到空数据库前，请先确认目标环境的 `.env` 中 `APP_MASTER_KEY` 是原来的值：

```bash
./scripts/compose-main.sh exec -T postgres psql -U wangpan -d wangpan < wangpan-YYYY-MM-DD.sql
```

还应备份：

- 主 VPS `.env`
- 远端 agent `.env`
- Docker volumes 或绑定挂载目录中的 agent 密文对象
- PostgreSQL volume 或定期 `pg_dump`

## 文件策略和 Stage 8 运维语义

策略：

- `standard`：普通文件，单副本。
- `important`：重要文件，要求至少双副本。
- `temporary`：临时文件，必须设置未来过期时间，后台任务会清理过期文件和副本。

Stage 8 相关操作：

- 回收站：`DELETE /files/:id` 会把文件移到 `TRASHED`，不会立即删除 storage-agent 上的密文副本。
- 恢复：`POST /files/:id/restore` 会把 trashed 文件恢复为 active，恢复后可重新出现在列表并下载。
- 彻底删除：`POST /files/:id/purge` 会删除或标记删除副本，并把文件置为 deleted。
- 版本历史：`GET /files/:id/versions` 返回版本列表，新版本在前。下载旧版本走 `GET /files/:id/versions/:versionId/download`。
- 管理员用户：管理员可禁用/启用用户、重置密码。禁用用户后登录和已有 session 会失败关闭；重置密码会使该用户已有 session 失效。
- 审计日志：`GET /access-logs` 支持 `page`、`pageSize`、`from`、`to`、`action`、`result`、`fileId`、`shareLinkId`、`actorId`。
- 后台维护：API 启动后每 60 秒运行一次维护任务。任务会把过期分享标记为 expired，删除过期 active temporary 文件及副本，刷新 storage node 状态，并触发重要文件副本维护入口。已经在回收站里的过期临时文件不会被 restore 重新激活。

## 环境变量保护

`docker-compose.main.yml` 和 `docker-compose.agent.yml` 对关键变量使用 compose required variable 语法。缺少 `POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`COOKIE_SECRET`、`LOCAL_AGENT_TOKEN`、`BOOTSTRAP_ADMIN_*`、`NODE_ID` 或 `AGENT_TOKEN` 时，compose 会直接失败，不会用空 secret 启动服务。`MAX_UPLOAD_BYTES` 和 `SESSION_TTL_DAYS` 有默认值，也会从 `.env` 传入 API 容器。

## 开发

```bash
npm install
npm run prisma:generate
npm run dev:api
npm run dev:agent
npm run dev:web
```

## 测试与验收

本仓库使用 Node 内置 test runner，通过各 workspace 的 `tsx --test` 执行 TypeScript 测试：

```bash
npm test
```

关键覆盖点：

- `packages/shared/src/policies.test.ts`：副本策略、策略继承、临时文件过期校验、权限等级、分享链接可用性和不可信输入归一化。
- `apps/api/src/permissions.test.ts`：文件/文件夹读写管理权限、祖先文件夹权限继承、owner/admin 快捷授权。
- `apps/api/src/crypto.test.ts`：AES-256-GCM envelope encryption 往返、明文/密文 hash 记录、错误 master key 拒绝解密。
- `apps/api/src/cleanup.test.ts`：过期分享标记、过期 temporary 文件删除流程、触发副本删除入口和 important backfill 的维护任务入口。
- `apps/api/src/replication.test.ts`：whole/chunked 副本复制、fallback、hash mismatch、per-chunk encryption metadata 和 streamed chunk 读取。
- `apps/api/src/stage8.test.ts`：回收站、版本历史、访问日志分页过滤、管理员禁用/启用/重置密码。
- `apps/storage-agent/src/object-store.test.ts`：密文对象写入/读取/校验/删除、对象 ID 防路径穿越、hash mismatch 不落盘。

手工验收建议：

1. 用 admin 创建 member、文件夹和三类策略文件，确认 `important` 文件至少两个可用副本，`temporary` 文件必须设置未来过期时间。
2. 给 member 只授予 `read` 后确认可预览/下载但不可改名、删除或授权；提升到 `write` 后确认可上传到该文件夹；提升到 `manage` 后确认可授权、移入回收站、恢复和 purge。
3. 创建分享链接，分别验证无密码、有密码、过期时间、下载次数上限；次数达到上限后再次访问应返回过期/不存在。
4. 停掉一个 storage-agent 后下载 important 文件，应可从另一副本读取；恢复节点后维护任务应补齐缺失副本。
5. 上传后确认 API 容器临时目录没有遗留 `wangpan-upload-*` 文件，storage-agent 数据目录只有密文对象。
6. 在“版本历史”中下载旧版本，确认内容和当时版本一致。
7. 禁用用户后确认该用户不能登录，已有 session 访问 `/auth/me` 返回未认证；启用后可重新登录。
8. 用 `/access-logs` 或管理后台记录页验证分页和过滤条件。

## 最终部署检查清单

- [ ] 主 VPS `.env` 已生成强随机 `APP_MASTER_KEY`、`COOKIE_SECRET`、`POSTGRES_PASSWORD`、`LOCAL_AGENT_TOKEN`。
- [ ] `APP_MASTER_KEY` 已离线备份，且恢复演练时使用同一个值。
- [ ] PostgreSQL 已配置定期备份，并已验证 `pg_dump` 产物可用。
- [ ] 主站可通过 `PUBLIC_BASE_URL` 访问，HTTPS 下 `COOKIE_SECURE=true`。
- [ ] 第一个 admin 已创建，并已更换为长期安全密码。
- [ ] 本地 storage-agent 在管理后台健康。
- [ ] 每台远端 storage-agent 的 `/health` 和带 token 的 `/status` 可从主 VPS 访问。
- [ ] 远端节点已在 Web 管理后台添加，Base URL 使用私有 IP、WireGuard IP 或 TLS 地址。
- [ ] 防火墙只开放必要端口，agent 端口不裸露给不可信公网。
- [ ] 上传 `standard`、`important`、`temporary` 文件并验证副本数、下载、版本历史、回收站恢复和 purge。
- [ ] 验证管理员禁用/启用/重置密码和审计日志分页过滤。
