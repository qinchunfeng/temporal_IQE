# AGENTS.md — IQE V3（temporal_IQE）仓库级 AI 开发约束

本文件约束在 **本仓库（`temporal_IQE/`，V3 Temporal 分支）** 内工作的 AI agent。人类入口见 [README.md](README.md)，功能见 [FEATURES.md](FEATURES.md)，进度见 [PROGRESS.md](PROGRESS.md)。

## 0. 核心原则

**LLM 负责判断，代码负责边界。** 借鉴 super-agent 的 Router/Worker 哲学，但不引入自主机制：护栏、签名归一化、verdict 兜底、状态机、预算、Mandate 校验必须是**纯代码 + 单测**，不得依赖 LLM 输出。LLM 失效时代码依事实接管（降级）。

## 1. 分区与所有权（务必先读）

- 本仓库 = V3 分支命名空间，V3 会话所有。根目录 `IQE_DSH/` **非 git**，无合并安全网。
- **只读路径，不得写**（含"顺手修复"）：根 `AGENTS.md`、`docs/`、上游克隆 `agent-autoloop/` `pi/` `temporal/`、V2 feasibility 文件。变更需求经所有者会话或用户裁决。
- `shared/`（signature/verdict/statemachine）V3 首落，`shared/OWNERS.md` 登记；V2 未来只读复用。
- 设计源 `../feasibility/v3-temporal-design.md` 由 V3 会话维护，保留在 feasibility/ 原地（被只读 docs/ 引用）。
- 项目记忆条目带 `[V3]` 前缀；**底盘级结论（D7）裁决前不写入共享记忆**。

## 2. 参考源限制

- **不得读取或引用 `docs/reproduction-agent-design.md`** 作为设计/实现/决策依据（用户 2026-11-19 确认失效）。其他文档引用它的内容仅视为历史背景。

## 3. 契约与确定性

- 契约以 `contracts/*.schema.json` 为**唯一事实源**；改契约升 `schema_version` 并同步两端校验（`validate.ts`）。
- workflow 代码保持**确定性**：LLM/IO/时钟一律 activity 或 SDK side-effect API。workflow 内用 `Date.now()`（沙箱确定性）；`@temporalio/workflow` **无 `now` 导出**。变更走 versioning。
- TS SDK 与 server image 版本锁定（auto-setup 1.28.1）；升级重跑 M2/M3 验收（含 replay）。
- e2e teardown 须 `await worker.run()` promise 再 close connection。

## 4. 护栏与外部副作用（G1–G11）

- 护栏清单见 README/FEATURES；任何改动不得削弱 G1–G11。
- CI/Jira/Azure 写**只走 guarded activity 单通道**；**不得实现 clear/delete/pause 类破坏操作**。
- G1：CI 触发 allowlist（默认空=全拒）+ run_ref 强制 `repro__` 前缀 + conf 复用原始 run（不可改）。
- G7：外部写幂等键 `incident_id+attempt`；CI 触发 409 → dedup。
- G6：verdict 兜底必须传**含 signature_match 的 reruns**，而非原始 facts。

## 5. 执行模式与确认门

- **默认 dry_run**（fake-ci）。`IQE_FAULT_INJECT` 故障注入钩子**仅 dry_run 生效**。
- **切 live、真实触发、改外部系统配置前必须征得用户确认**（G2 / D14）。真实 Airflow 触发会重启物理设备并跑 bench，消耗外部算力——不得超出 allowlisted DAG。
- dotenv 不覆盖已存在 shell env：`IQE_EXECUTION_MODE=live npm run dev:workers` 临时切 live。

## 6. 凭据与日志

- 凭据**只进 `workers/.env`**（gitignore + chmod 600）；代码与日志**不得出现明文密码/API key**。
- 客户端模型鉴权用 `PROXY_API_KEY`（如 `sk-qoder-local-…`），**不是**上游 PAT。
- `kb/` `work/` `node_modules/` `*.log` gitignore（运行时产物含会话/transcript，不入库）。提交前扫描暂存内容确认无秘密。

## 7. 测试纪律

- 每里程碑交付**可运行验收命令**；纯代码护栏配单测。
- 测试隔离：`IQE_WORK_DIR` 指 tmp、fake-ci 临时端口、矩阵内 `IQE_HOURLY_RERUN_CAP=1000`（时帽由 cap=0 专测覆盖）。
- M1/M2 矩阵 e2e **强制角色降级**（beforeAll 把 `*_MODEL_BASE_URL` 指向不可达地址 → stub fallback，等价 M2 基线，兼降级演练）；真实 LLM 路径仅 e2e-m3 覆盖。否则真实 LLM 延迟吃掉短墙钟预算。
- **e2e 不可与 live workers 并行**：e2e 起自己的 Worker poll 同一 namespace/task-queue，会抢任务串扰。跑全量回归前先停 live workers。
- **改适配器/活动代码后必须重启 workers**：tsx 启动时加载模块，运行中进程持旧代码。
- 长时 live 复现用 `inject --no-wait`（Bash 后台 timeout 上限 10min < bench ~28min），workflow 由 Temporal+workers 独立处理。

## 8. 范围纪律

- 按 M1→M4 增量实现，**不提前扩范围**；已有项目严格增量，交付测试/验收。
- 不添加任务所需之外的功能/抽象/错误处理；不为假设的未来需求设计。
- 默认不写注释；仅在 WHY 非显然时写一行。

## 9. 常用命令

```bash
npm install                 # workspaces 安装
npm run typecheck           # tsc --noEmit
npm test                    # vitest 全量（116）
npm run dev:workers         # 7 Worker（mode 由 env）
npm run fake-ci             # dry_run 模拟 CI
npm run inject -- --scenario stable_fail [--no-wait ...]
npm run metrics             # 按 model 归因报表
```

chassis：`cd deploy && docker compose up -d`；namespace 注册见 README（server 监听容器 IP，retention 须带单位）。