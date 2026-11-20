# FEATURES.md — IQE V3 功能目录

功能映射到代码。状态：**全部已落地并随 M1–M4 验收**（116/116 测试）。路径相对 `temporal_IQE/`。

## 1. 耐久底盘与编排

| 功能 | 说明 | 代码 |
|---|---|---|
| Temporal 底盘 | namespace `iqe-v3`（retention 7d）；auto-setup 1.28.1 + postgres16 + UI | `deploy/docker-compose.yml` |
| 7 task queue Worker | 单进程托管 iqe.case/router/triage/repro/ticket/review/reporting | `workers/src/worker.ts` |
| 确定性 case workflow | 阶段编排 + 信号/条件/睡眠 + hop 计数 + 崩溃恢复 | `workers/src/case.workflow.ts` |
| 配置中心 | env getter + effectivePolicy 钳制 + roleModel | `workers/src/config.ts` |

## 2. 契约与校验

| 功能 | 说明 | 代码 |
|---|---|---|
| 4 JSON Schema（v3.0） | case-input / dispatch-decision / slices / case-close | `contracts/*.schema.json` |
| 两端校验 | assertValid 绑定 schema；切片写前校验 | `workers/src/validate.ts`、`types.ts` |

## 3. 护栏 G1–G11（纯代码 + 单测）

| 护栏 | 功能 | 代码 |
|---|---|---|
| G1 | CI 写 allowlist + `repro__` 前缀 + conf 复用不可改 | `activities.ts` ciTrigger |
| G2 | dry_run/live 模式门 + 外部边统一入口 | `config.ts` mode、`activities.ts` |
| G3 | Mandate 校验 + 非法 dispatch 拒收 | `workers/src/mandate.ts` |
| G4 | 单一写入者 + state 迁移转换表 | `shared/statemachine.ts`、`kb.ts` |
| G5 | 签名归一化（去时间戳/UUID/路径/地址，排序去重） | `shared/signature.ts` |
| G6 | verdict 兜底判定表（LLM 失效依事实判定） | `shared/verdict.ts` |
| G7 | 外部写幂等键（incident_id+attempt；CI 409 dedup） | `activities.ts`、`ci-airflow.ts` |
| G8 | 摄入 admission：source 白名单 + 每小时上限 | `workers/src/admission.ts` |
| G9 | Router 只读工具面（无领域工具/写路径） | router worker 配置 + `prompts.ts` |
| G10 | 凭据仅 worker `.env`（chmod 600，gitignore） | `config.ts`、`workers/.env.example` |
| G11 | 全量审计：workflow history + KB transcript NDJSON | `kb.ts`、`harness.ts` |

## 4. 预算与状态

| 功能 | 说明 | 代码 |
|---|---|---|
| 复现预算 | max_reruns=2 / timeout 30min / 全局时帽 10/h（ledger 硬拒） | `workers/src/budget.ts`、`work/rerun-ledger.jsonl` |
| 返工上限 | MAX_REWORK=1；超限→inconclusive | `case.workflow.ts` |
| 状态机 | new→triaged→reproducing→ticketed→reviewing→closed/dead 转换校验 | `shared/statemachine.ts` |

## 5. LLM harness 与角色

| 功能 | 说明 | 代码 |
|---|---|---|
| resume-per-call 会话 | router-global/triage-/ticket- 续会话；review-<incident>-<round> 不续、异构 pro | `workers/src/harness.ts` |
| 会话外置 + 审计 | sessions/*.json（cap 20）+ transcript NDJSON + llm-usage 账本 | `harness.ts`、`work/sessions/` |
| JSON 提取 | extractJson 容错解析 LLM 输出 | `workers/src/json.ts` |
| 角色 prompt | Router/Triage/Ticket/Review system prompt | `workers/src/prompts.ts` |
| LLM-first + 降级 | triage/ticket/review activity 内 catch→代码 stub；router 降级走 fastPath | `activities.ts`、`fastpath.ts` |
| Triage | 分类 + qualifies_for_reproduction；live 取真实 task 日志 | `activities.ts` triageRun |
| Ticket | 起草工单；返工标题代码追加后缀 | `activities.ts` ticketRun |
| Review | 独立异构模型 approve/reject/need_info | `activities.ts` reviewRun |

## 6. Router 咨询与历史跳步

| 功能 | 说明 | 代码 |
|---|---|---|
| 入口 dispatch（D8） | Router 提议 dispatch/skip/ask；代码校验 Mandate | `activities.ts` routerDispatch、`mandate.ts` |
| 关闭 acceptance（D8/D19） | 携真实复现证据 + baseline_source 咨询；拒绝→通知 | `activities.ts` routerAccept |
| fastPath 降级 | Router 失效/坏 JSON → 代码默认 dispatch | `workers/src/fastpath.ts` |
| 历史跳步（D11） | signature+confHash+provider+reproduced+7d 窗；Router 提议→代码复核 owns refs；默认 off | `workers/src/history.ts`、`activities.ts` historyCandidate |

## 7. CI 适配器

| 功能 | 说明 | 代码 |
|---|---|---|
| dry_run 模拟 CI | 状态机 stable_fail/flaky/all_pass/paused/timeout + /original-log + /stats | `simulator/fake-ci.ts` |
| live Airflow 适配器 | JWT 鉴权 / 触发 409 幂等 / 轮询 task try_number + 日志 event 提取（content 键）/ 状态映射 | `workers/src/ci-airflow.ts` |
| live 分支接入 | ciTrigger/ciPoll/reproFinalize/triageRun live 路径（dry_run 不变） | `activities.ts` |
| 复现判定 | reproFinalize 从原始 run 日志算 baseline + signatureMatch + fallbackVerdict | `activities.ts` reproFinalize |

## 8. 度量与运维

| 功能 | 说明 | 代码 |
|---|---|---|
| metrics 按 model 归因 | llm-usage 账本→closeCase 聚合→aggregateByModel 报表 | `workers/src/metrics.ts` |
| 故障注入（dry_run only） | router_fail/router_bad_mandate/router_bad_json/review_reject_once/review_reject_always/review_need_info/trigger_crash_once | `config.ts` faultInject、`activities.ts` 钩子 |
| 单向通知 | acceptance_rejected / case_dead / need_info_timeout 等 | `activities.ts` notify、`work/notifications.jsonl` |
| KB 持久化 | cases/<id>/ 切片 + transcript + lesson 蒸馏 | `workers/src/kb.ts` |
| 摄入 CLI | inject-case flags（scenario/incident/timeout/max-reruns/failed-tasks/source/config-rev/no-wait） | `simulator/inject-case.ts` |

## 9. 测试覆盖

| 类别 | 文件 |
|---|---|
| 纯单测 | contract / signature / verdict / statemachine / json / mandate / budget / admission / history / harness / metrics / ci-airflow |
| e2e（需 Temporal） | e2e-dryrun（M1 矩阵）/ e2e-matrix（M2 全矩阵+崩溃恢复）/ e2e-m3（真实 LLM+跳步+降级+验收回归） |

详见 [README.md](README.md#测试) 测试隔离纪律。