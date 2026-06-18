# 深信服 AC 上网行为管理统一管理系统

对多台深信服上网行为管理（AC）设备做集中管理：在一处维护多个实例的地址与凭据，统一查看、编辑并跨实例同步「自定义应用规则 / 自定义 URL 库 / 访问权限策略」，所有写操作留存审计日志。

接口层由 [`hznmops`](../../hznmops) 项目中已验证的 `sangfor_web.py` / `sangfor_api.py` 改造而来，复用其 RSA 登录 + CSRF 握手与各 CGI 报文逻辑。

## 功能

| # | 功能 | 说明 | 接口来源 |
|---|---|---|---|
| 1 | 自定义应用 | 仿原生管理表格（序号/规则名称/描述/应用类型/应用名称/状态/删除）；点规则名打开仿原生「编辑自定义应用」对话框；新增/编辑/删除 | `/cgi-bin/customrule.cgi` |
| 1b | 数据校验 | 自定义应用桑基图（策略→应用→协议端口→IP/域名）、自定义 URL 桑基图（策略→URL库→URL条目）、力导向应用关系图；策略→应用/URL 连线按动作着色（放行绿/拒绝红，多规则引用同对象时按「首条命中规则」为准）；私有条目按类型聚合、共享条目标红；两张桑基图可一键导出为**自包含离线 HTML**（ECharts SVG 渲染，矢量无极缩放、保留悬停高亮分支与提示框）；分析结果带服务端 TTL 缓存（默认 5 分钟），「重新分析」强制刷新 | 聚合 customrule + objurlgrp + netpolicy 详情 |
| 2 | 自定义 URL 库 | 仿原生管理表格（URL类别名称/描述/类型/删除，层级缩进）；点类别名打开仿原生「编辑URL类型」对话框（自定义库可编辑、内置库只读查看）；新增/编辑/删除自定义库 | `/cgi-bin/objurlgrp.cgi` |
| 3 | 访问权限策略 | 仿原生管理表格（复选框/序号/策略名称/适用用户/适用位置/适用目标区域/策略管理员/上移下移/过期日期/状态/删除，已过期标红）；上下移箭头调整顺序、勾选多行批量启用/禁用、行内删除（二次确认后均真实写入）；点策略名或「新增」打开**仿原生「访问权限策略」对话框（新建/编辑同一界面）**：启用该策略/名称/描述 + 「应用控制」规则增删改（每条经仿原生「选择适用应用」选择器设动作/生效时间/应用·URL，含自定义/内置应用与 URL） | `/cgi-bin/netpolicy.cgi` |
| 4 | 增删改 + 审计 | 对 1–3 的写操作（dry-run 预览 + 确认后真实写入）并记录日志 | 同上 |
| 5 | 跨实例同步 | 选源选目标预览差异 / 二次确认后真实写入（应用·URL 直写；策略据目标 crc 重映射，缺失的自定义引用自动先建、内置缺失则阻止） | 组合上述接口 |
| 6 | 多用户 / 权限（预留） | 已建表与依赖占位，本期不实现 | — |

## 技术栈

- 后端：FastAPI + SQLAlchemy 2.0 + SQLite（凭据 Fernet 加密存储）
- 前端：React + Vite + TypeScript + Tailwind CSS + shadcn 风格组件（暗色主题以近纯黑中性面为主，发丝边框 + 单一克制紫强调色，参考 Linear / Vercel 一类风格）
- 列表：TanStack Table（列排序、分面筛选、表头固定）；可视化：ECharts 桑基图（懒加载）；数据请求：TanStack Query + axios

## 目录

```
backend/   FastAPI 后端
  app/sangfor/      AC 客户端：web_base（RSA 登录+CSRF+_post/_write_cgi）+
                    customrule_cgi / url_cgi / policy_cgi（各 CGI 能力 mixin）
                    → web_client 组合成 SangforWebClient；api_client；session_pool
  app/services/     业务编排：customrule_service（重叠/冲突分析）、policy_relations
                    （策略↔应用/URL 关系+名称匹配）、policy/url/sync/instance_service、customrule_form
  app/routers/      REST 路由（仅做异常→HTTP 映射，调用 service）
  app/schemas/ core/ db/   Pydantic 模型 / 加密·审计·鉴权 / ORM
frontend/  React 前端
  src/pages/                各功能页（含 validation 数据校验页，仅状态编排+JSX）
  src/lib/validation/       constants（配色/类型）+ model（桑基/力导向 option 纯构建器）
  src/components/validation/ legend-chip / check-list / stat
  src/components/           data-table、policy-editor、app-picker、ref-chip、ui/* 等
  src/lib/                  api、types、chart-export、policy-refs、customrule 等
```

## 快速开始

### 后端

```bash
cd backend
uv sync                     # 安装依赖
cp .env.example .env        # 按需配置 SANGFOR_SECRET_KEY
uv run uvicorn app.main:app --reload --port 8000
```

打开 http://127.0.0.1:8000/docs 查看 API 文档。

> 所有环境变量统一使用 `SANGFOR_` 前缀（如 `SANGFOR_DEBUG` / `SANGFOR_DATABASE_URL` / `SANGFOR_CORS_ORIGINS` / `SANGFOR_REQUEST_TIMEOUT`），避免误读系统里的同名通用变量（如裸 `DEBUG`）。
>
> 生产环境务必在 `.env` 中设置固定的 `SANGFOR_SECRET_KEY`（Fernet key），否则换机后已存凭据无法解密。
> 生成方式：`uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
>
> **鉴权**：设置 `SANGFOR_API_TOKEN` 后，所有 `/api` 接口（健康检查除外）要求请求头 `X-API-Token`（或 `Authorization: Bearer <token>`）与之匹配；前端在 `frontend/.env` 配置同值的 `VITE_API_TOKEN` 即可自动携带。未设置时不鉴权（仅限受信任内网，后端启动时会打印告警）。
>
> 与 AC 通信默认不校验 TLS（适配自签证书设备）；如需校验可设 `SANGFOR_VERIFY_TLS=true`（系统 CA）或指定 CA 证书文件路径。

### 前端

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173 （已配置 /api 代理到 8000）
```

> 若后端启用了 `SANGFOR_API_TOKEN`，在 `frontend/.env` 中设置同值的 `VITE_API_TOKEN`，前端会自动给所有请求附带 `X-API-Token` 头。

## 使用流程

1. 「实例管理」中新建实例，填写地址与凭据，点「测试」确认连通。
2. 顶部实例切换器选择当前实例，进入「自定义策略 / 自定义 URL / 访问权限策略」查看配置。切换器每个实例名前有连接状态圆点（绿=正常 / 红=连接失败 / 黄=未配置凭据 / 灰=已禁用），下拉展开时探测各实例、当前实例常驻探测；连接失败的实例仍可选中以便排查或重测（采用复用会话的轻量健康检查，不影响已登录会话）。
3. 「实例同步」选择源实例与对象（对象名称为带搜索的下拉框，条目多时可直接输入关键字过滤），预览差异后同步到目标实例，或一键推送到全部。差异预览按对象友好展示：自定义应用/URL 做字段级对比（IP/域名/URL 列表做行级增删、相同项弱化折叠），访问权限策略按规则顺序对位、细化到规则内部应用/访问网站的增删；卡片标题显示「源 → 目标」。点「同步到所选目标 / 一键推送到全部」会弹出二次确认，可选「仅预览（dry-run）」或「确认写入」；改动左侧配置后右侧预览不清空而是标记「已过期」并提示重新预览。
4. 「操作日志」查看所有写 / 同步动作的审计记录。每条都带可读「摘要」（如「新增规则：拒绝 → 钉钉、微信」「新增 URL 库『test』（2 条 URL/IP）：1.1.1.1、example.com」「新增自定义应用『app』（IP 2 条：…）」）；顶部搜索框对摘要 / 对象 / 操作人 / 实例 / 变更前后快照做子串检索——可按你添加过的 IP、域名、URL 等直接搜到相关记录。策略编辑的「变更前/后」存精简的「规则=动作+引用」快照而非整条原始报文。

## 写操作安全模式（重要）

读功能已完整可用。**写操作默认安全**：所有写入口（增删改、同步落盘）均支持 `dry_run`，仅构造并返回将提交给 AC 的报文、不改动设备；只有显式确认（开关 / 二次确认弹窗）后才以 `dry_run=false` 真实提交。未在 `CONFIRMED_WRITES` 白名单中的写操作即便传 `dry_run=false` 也会被拦截。

已确认并可真实写入：

- **自定义应用「新增(add)」「编辑(modify)」「删除(delete)」**（据真实抓包对齐报文结构）。新增/编辑在表单底部打开「实际写入设备」开关提交（默认关闭，仅预览）；删除点行内删除图标并二次确认后直接真实写入。
- **访问权限策略「编辑(modify)」**：点策略名打开仿原生「访问权限策略」对话框（与「新建」同一界面），可改启用该策略 / 描述、增删改「应用控制」规则（动作 + 引用的应用/URL）。采用「读—改—写」往返——后端先 `listItem` 取回完整策略对象，替换 `appctrl.application.data`（按规则名匹配，新增规则生成 ID、未提交的删除）与 include/enable/depict，其余配置（keyword/filetype/saas/mail/适用对象/高级配置…）原样保留，再以 `opr=modify` 提交。名称只读（按名匹配往返）；底部「实际写入设备」开关默认仅预览。
- **访问权限策略「上移(moveup)」「下移(movedown)」**（调整策略执行顺序，据真实抓包对齐）。策略列表「上移/下移」列的箭头点击后直接真实写入并刷新顺序（首/末行对应箭头置灰）。
- **访问权限策略「批量启用(enable)」「批量禁用(disable)」**（`name` 为名称数组，据真实抓包对齐）。策略列表勾选多行后，右上工具栏「启用/禁用」直接真实写入。
- **访问权限策略「新建(add)」**（`opr=add`，`data` 结构同 modify，默认骨架取自真实抓包）。「新增」与上面的「编辑」共用同一对话框，新建时名称可填（重名校验）。当前默认只建「访问权限策略」、只配「应用控制」；**适用用户不在新建报文中**（设备另存），新建后需在 AC 配置适用人员。
- **自定义 URL 库「新增(add)」「编辑(modify)」「删除(delete)」**（据真实抓包对齐报文：`data` 为 `{id,name,depict,url,keyword}`，`url` 为换行分隔的 URL/IP；删除 `name` 为名称数组）。在「自定义 URL 库」页点「新增 URL 库」或点开某自定义库后「编辑 / 删除」；新增/编辑有「实际写入设备」开关（默认仅预览），删除二次确认后真实写入。

- **访问权限策略「删除(delete)」**（据真实抓包对齐报文：`opr=delete`、`name` 为名称数组）。策略列表「删除」列点垃圾桶图标并二次确认后直接真实写入并刷新。

> **跨实例同步落盘**：自定义应用 / URL 库可真实写到目标实例（复用上述已确认报文）。在「实例同步」页点「同步到所选目标 / 一键推送到全部」会弹出二次确认，列出对象、源/目标实例，可选「仅预览（dry-run）」或「确认写入」；真实写入后自动失效目标实例的分析缓存。
>
> **访问权限策略的跨实例同步（含 crc 重映射 + 引用对象自动创建）**：apply 时预读源实例的**完整策略对象**与源自定义应用 / URL 名单，再据目标实例的应用目录树（`listAppTree`）按引用路径反查目标自己的 `crc`——解决「crc 由各设备独立分配、源 crc 在目标无效」的核心障碍。落盘走**已验证的写路径**：目标已有同名策略 → `modify_policy_application`（读目标自身策略为底座、仅替换规则的动作与引用，其余原样保留，与单实例编辑同一契约）；目标无此策略 → `create_policy`（`opr=add`，data 取自源对象、crc 重映射）。
> - **引用对象自动创建**：策略引用的对象若目标缺失，会区分「自定义」与「内置」——缺失的**自定义**应用 / URL 库会复用已确认写接口先建到目标（按源同名对象创建），再同步策略；缺失的**内置**对象无法创建，真实写入时会**整体阻止**（不创建任何对象、不写策略）并在结果列出，dry-run 时则在预览中提示。
> - 结果卡片可展开「查看重建报文（含目标 crc）」核对；适用用户不随报文跨实例，新建策略后需在目标手工配置适用人员。
> - 引擎见 [`app/services/policy_sync.py`](backend/app/services/policy_sync.py)：`build_app_index`（树→`path→{crc,type}` 索引，每目标建一次）、`build_remapped_rules`（重映射规则引用 crc）、`classify_missing`（缺失分「可自动创建/内置硬缺失」）、`create_referenced_objects`（建自定义引用）、`sync_policy_to_target`（编排）。差异预览（diff）对三类对象均可用。
>
> 同步差异预览会区分「目标不存在（可新增）」与「读取失败」：读取/解析失败时明确报错、不再误判为「将新增」，且 apply 阶段会跳过读取失败的目标、不会据此误新增。
>
> **访问控制**：真实写入入口（策略上下移、批量启停、各类增删改、同步落盘）默认不鉴权。部署到非完全可信网络前，请设置 `SANGFOR_API_TOKEN` 启用令牌校验（见上文「快速开始」）。

> 协议字段据抓包确认 TCP=0；UDP/ICMP 标签为推测，可按需调整 `PROTOCOL_OPTIONS`。
>
> **应用树与 crc**：策略里每个应用/网址以 `{path, type, crc}` 表示。`crc` 一律取自设备——「选择应用 / URL」选择器的应用树来自 `acnetpolicy.cgi` 的 `listAppTree`（[`web_client.list_app_tree`](backend/app/sangfor/web_client.py)，经 `GET …/policies/app-tree` 暴露），树中每个节点带 `name`/`type`（`catagory`/`app`）/`crc`/`value`（即引用 path），内置应用、自定义应用与「访问网站」URL 类目都在其中，选中即用其 `value`/`type`/`crc` 构造引用，**无需臆造 crc**。请求参数对齐 AC 原生对话框（`containFileType=false`、`containUrlType=false`）：此时「访问网站」下的各 URL 库（含「网站浏览/文件上传/其他上传/HTTPS」4 个子类）已**内联**在树中、点开无需再请求；注意 `containUrlType=true` 反而会清空「访问网站」子树。

通用启用真实写入的步骤：

1. 在 AC 控制台对某类对象做一次增/改/删，用浏览器开发者工具抓取请求的 URL 与 payload。
2. 据此核对/补全 [`backend/app/sangfor/web_client.py`](backend/app/sangfor/web_client.py) 中对应的 `create_* / update_* / delete_*` 报文。
3. 把已确认的 `(cgi_path, opr)` 登记到该文件顶部的 `CONFIRMED_WRITES` 集合。
4. 调用写接口时传 `dry_run=false` 即可真正提交；未登记的写操作会被拦截以防误写。

## 规则动作（允许/禁止）字段说明

访问权限策略详情中，每条规则的动作（允许/禁止）由 [`web_client.get_policy_detail`](backend/app/sangfor/web_client.py) 的 `extract_action` 从规则报文里按常见键名（`action`/`act`/`permit` 等）容错解析并归一化为 `allow`/`deny`/`unknown`。不同 AC 固件字段命名可能不同——若界面上动作显示为「未知」，打开该策略详情的「原始数据」标签，把规则里的动作字段名/取值告知，即可在 `extract_action` 中补全映射。

## 未来扩展：多用户与权限

- ORM 已含 `User / Role / Permission` 占位表（见 [`backend/app/db/models.py`](backend/app/db/models.py)）。
- 所有业务路由通过 [`get_current_user`](backend/app/core/auth.py) 依赖获取操作人，本期固定返回管理员。
- 接入真实登录时只需替换该依赖实现（解析 token、查库、校验 `permissions`），业务路由签名无需改动。
