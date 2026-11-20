# IQE V3 — Temporal 底盘 CI 失败验证流水线

基于 **Temporal** 耐久执行底盘的 CI 失败复现/验证流水线（IQE = Incident Qualification Engine）。借鉴 super-agent 的 **Router/Worker 哲学**，但**不引入自主机制**：核心原则是「**LLM 负责判断，代码负责边界**」——所有护栏、签名归一化、verdict 兜底、状态机、预算均为纯代码 + 单测，LLM 失效时代码依事实接管。

> 状态：**M1–M4 全部验收通过**（116/116 测试绿 + live 真实 Airflow 复现）。本仓库是 IQE 的 **V3 平行备选底盘分支**；底盘最终裁决（决策项 D7）仍开放，详见 [PROGRESS.md](PROGRESS.md)。

## 它做什么

给定一个 CI 失败 incident（Airflow DAG run），流水线自动：

1. **Router** 入口咨询 → 派活（dispatch）或历史跳步（skip）；
2. **Triage** 分类失败、判定是否值得复现；
3. **Repro** 在 allowlist 内触发 CI 重跑、轮询、提取日志签名、依事实判定 verdict（reproduced / flaky / not_reproduced / inconclusive / skipped）；
4. **Ticket** 起草工单；**Review** 独立异构模型审查（approve / reject 返工 / need_info）；
5. **Router** 关闭验收咨询 → 蒸馏 lesson → 关闭 case，全程审计落盘。

## 架构

- **底盘**：Temporal（namespace `iqe-v3`，retention 7d），单进程托管 **7 个 task queue** 的 Worker：`iqe.case`（workflow）/ `iqe.router` / `iqe.triage` / `iqe.repro` / `iqe.ticket` / `iqe.review` / `iqe.reporting`。
- **编排**：`case.workflow.ts` 确定性工作流；LLM/IO/时钟一律走 activity。
- **角色 LLM**：resume-per-call 会话（router-global / triage- / ticket- 续会话；review-<incident>-<round> 不续、异构 pro 模型）；每角色 LLM-first，activity 内 catch → 代码 stub 降级。
- **护栏 G1–G11**：见下表与 [FEATURES.md](FEATURES.md)。

| 护栏 | 内容 |
|---|---|
| G1 | CI 写 allowlist（默认空=全拒）+ run_ref 强制 `repro__` 前缀 + conf 不可改 |
| G2 | `IQE_EXECUTION_MODE=dry_run\|live`，默认 dry_run；切 live 需用户显式确认 |
| G3 | Mandate 校验 + 非法 dispatch 拒收 |
| G4 | 单一写入者 + state 迁移转换表校验 |
| G5 | 签名归一化（task 集 + 错误指纹去时间戳/UUID/路径/地址，排序去重） |
| G6 | verdict 兜底判定表（LLM 失效时代码依事实判定） |
| G7 | 外部写幂等键（incident_id+attempt；CI 触发同） |
| G8 | 摄入 admission：source 白名单 + 每小时上限 |
| G9 | Router 只读工具面（无领域工具、无写路径） |
| G10 | 凭据仅 worker `.env`（chmod 600，不入 git） |
| G11 | 全量审计：workflow history + KB transcript（NDJSON） |

## 目录结构

```
temporal_IQE/
├── contracts/            # 4 个 JSON Schema（case-input/dispatch-decision/slices/case-close，v3.0）— 契约唯一事实源
├── shared/               # signature/verdict/statemachine（V3 首落，OWNERS.md 登记；V2 只读复用）
├── workers/
│   ├── src/              # config/validate/mandate/fastpath/kb/budget/admission/activities/
│   │                     # case.workflow/worker/harness/history/json/prompts/metrics/ci-airflow/types
│   ├── .env.example      # 环境模板（空值；cp 为 .env 后填凭据）
│   └── .env              # 真实凭据（gitignore，chmod 600）
├── simulator/            # fake-ci（dry_run CI 状态机）+ inject-case（摄入 CLI）
├── tests/                # 15 文件 116 测试（单测 + 全矩阵 e2e + 崩溃恢复 + 真实 LLM e2e）
├── deploy/               # docker-compose.yml（Temporal + PostgreSQL + UI）
├── kb/                   # 运行时：cases/<id>/ 切片 + transcript（gitignore）
└── work/                 # 运行时：sessions/ledger/notifications（gitignore）
```

## 快速开始

### 前置

- Docker + Docker Compose
- Node.js ≥ 22
- （真实 LLM 路径）一个 OpenAI 兼容端点，如本地 qoder-proxy `http://127.0.0.1:3000/v1`

### 1. 起底盘

```bash
cd deploy && docker compose up -d        # Temporal gRPC :7233 / UI :8280 / PostgreSQL :5433
```

注册 namespace（server 监听容器 IP 而非 127.0.0.1；retention 须带单位）：

```bash
docker exec iqe-v3-temporal temporal operator namespace create \
  --namespace iqe-v3 --retention 7d \
  --address $(docker exec iqe-v3-temporal hostname -i):7233
```

UI 访问 `http://127.0.0.1:8280`。

### 2. 配置与安装

```bash
cd ..                                     # 回到 temporal_IQE/
cp workers/.env.example workers/.env
chmod 600 workers/.env                    # 填入凭据；.env 不入 git
npm install                               # workspaces 安装 workers 依赖
```

### 3. dry_run 联调

```bash
npm run fake-ci                           # 起模拟 CI（默认 :8200）
npm run dev:workers                       # 起 7 个 Worker（mode=dry_run）
npm run inject -- --scenario stable_fail  # 注入一个 case，等待关闭
```

### 4. 测试与度量

```bash
npm run typecheck                         # tsc --noEmit
npm test                                  # vitest 全量（116 测试）
npm run metrics                           # 按 model 归因报表
```

## CLI 参考

| 命令 | 说明 |
|---|---|
| `npm run dev:workers` | 单进程托管 7 个 task queue 的 Worker |
| `npm run fake-ci` | dry_run 模拟 CI 状态机（`/trigger` `/runs/:ref` `/original-log` `/stats`） |
| `npm run inject -- [flags]` | 摄入一个 case 并启动 workflow |
| `npm run metrics` | 聚合 KB 内 llm-usage 账本，按 model 输出 turns/tokens/roles/cases |
| `npm test` | vitest 全量 |
| `npm run typecheck` | TypeScript 类型检查 |

`inject` flags：

| flag | 默认 | 说明 |
|---|---|---|
| `--scenario` | `stable_fail` | dry_run 场景：`stable_fail`/`flaky`/`all_pass`/`paused`/`timeout` |
| `--incident` | `inc-<ts>` | incident_id（亦即 workflowId，重复拒收） |
| `--timeout` | `30` | policy.timeout_minutes |
| `--max-reruns` | （用 cfg） | policy.max_reruns（受 cfg 上限钳制） |
| `--failed-tasks` | `run_kernel_test` | 逗号分隔失败任务集（live 真实任务为 `run_4-wait-ready`） |
| `--source` | `simulator` | 摄入 source（受 G8 白名单） |
| `--config-rev` | — | evidence_refs.config_rev（历史跳步 conf 哈希用） |
| `--no-wait` | off | 启动后立即返回（长时 live 复现用，workflow 由 Temporal 独立处理） |

## 执行模式

- **dry_run（默认）**：CI 走 fake-ci 状态机，不触达外部系统；故障注入钩子 `IQE_FAULT_INJECT` 仅此模式生效。
- **live**：CI 走真实 Airflow（`ci-airflow.ts`，JWT 鉴权 / 触发 409 幂等 / 轮询 task 日志）。**切 live 与真实触发前必须征得用户确认**（G2 / 决策 D14）。真实触发会重启物理设备并跑 bench，消耗外部算力。

## 配置

全部经环境变量（见 [workers/.env.example](workers/.env.example)）。关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` | `127.0.0.1:7233` / `iqe-v3` | 底盘地址/命名空间 |
| `IQE_EXECUTION_MODE` | `dry_run` | `dry_run`/`live` |
| `IQE_CI_ALLOWLIST` | （空=全拒） | 允许触发的 DAG（G1） |
| `IQE_MAX_RERUNS` / `IQE_TIMEOUT_MINUTES` / `IQE_HOURLY_RERUN_CAP` | `2` / `30` / `10` | 预算护栏 |
| `IQE_HISTORY_REUSE` / `IQE_HISTORY_WINDOW_DAYS` | `off` / `7` | 历史跳步开关/窗口 |
| `AIRFLOW_BASE_URL` / `AIRFLOW_USERNAME` / `AIRFLOW_PASSWORD` | — | live CI 凭据（仅 .env） |
| `<ROLE>_MODEL_BASE_URL` / `_API_KEY` / `_ID` | proxy / — / flash（review=pro） | 每角色模型端点 |

> dotenv 不覆盖已存在的 shell 环境变量：可用 `IQE_EXECUTION_MODE=live npm run dev:workers` 临时切 live。

## 测试

15 文件 116 测试：

- **纯单测**（无需 Temporal）：contract / signature / verdict / statemachine / json / mandate / budget / admission / history / harness / metrics / ci-airflow。
- **e2e**（需本地 Temporal）：e2e-dryrun（M1 矩阵）/ e2e-matrix（M2 全矩阵 + 崩溃恢复）/ e2e-m3（真实 LLM + 跳步 + 降级）。
- 测试隔离：`IQE_WORK_DIR` 指向 tmp、fake-ci 用临时端口、矩阵内 `IQE_HOURLY_RERUN_CAP=1000`；M1/M2 矩阵强制角色降级（端点指向不可达地址 → stub fallback，兼降级演练）；真实 LLM 仅 e2e-m3。
- **注意**：e2e 会起自己的 Worker poll 同一 namespace/task-queue，**不可与 live workers 并行**（抢任务串扰）；改适配器/活动代码后须重启 workers 才生效。

## 安全

- 凭据只进 `workers/.env`（gitignore + chmod 600）；代码与日志不得出现明文密码/API key。
- CI/Jira/Azure 写只走 guarded activity 单通道；**不实现 clear/delete/pause 类破坏操作**。
- `kb/` `work/` `node_modules/` `*.log` 均 gitignore（运行时产物含会话/transcript，不入库）。

## 分区契约

本仓库是 V3 分支命名空间。根目录（`IQE_DSH/`）非 git；上游克隆 `agent-autoloop/` `pi/` `temporal/` 与 `docs/` 双方只读。V2 未来从 `shared/` 只读复用。详见根 `AGENTS.md` 分区契约与 [AGENTS.md](AGENTS.md)。

## 相关文档

- [AGENTS.md](AGENTS.md) — 仓库级 AI 开发约束
- [FEATURES.md](FEATURES.md) — 功能目录（映射代码）
- [PROGRESS.md](PROGRESS.md) — 里程碑验收与决策日志
- 设计源：`../feasibility/v3-temporal-design.md`（V3 会话所有）