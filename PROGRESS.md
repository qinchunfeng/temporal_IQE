# PROGRESS.md — IQE V3 里程碑与决策日志

> 当前状态：**M1–M4 全部验收通过**，116/116 测试绿 + live 真实 Airflow 复现。底盘裁决 **D7 仍开放平行**。

## 里程碑

| 里程碑 | 日期 | 范围 | 验收证据 | 测试 |
|---|---|---|---|---|
| **M1** chassis | 2026-11-19 | Temporal 底盘 + 4 契约 + shared 资产 + 7 Worker + case workflow + fake-ci/inject | stable_fail→reproduced / all_pass→not_reproduced / flaky→flaky / paused+短墙钟→inconclusive+abandoned；重复 incident workflowId 去重；Mandate 非法 dispatch 单测拒收 | 52 |
| **M2** 护栏+恢复 | 2026-11-20 | G1–G11 落地 + G8 admission + 全局时帽 ledger + 单向通知 + 故障注入钩子 | 全矩阵 10 项 e2e + kill-worker 恢复不重复触发 + trigger 崩溃重试幂等 + need_info 超时通知 + 返工上限；allowlist 外/超预算拒收 | 71 |
| **M3** Router+回环 | 2026-11-20 | 真实 LLM harness（resume-per-call）+ Router 入口/关闭咨询 + triage/ticket/review LLM-first 降级 + 历史跳步 D11 | 真实 LLM stable_fail→reproduced（TAT 62.7s）；router_bad_json→fastPath；跳步 off 同签同配不跳、on 第三例 skipped/attempts=0/history_skip=true（code-verified refs）；CLI m3-accept-001 reproduced + 002 skipped 复用 001 | 97 |
| **M4** live+度量 | 2026-11-20 | Airflow 适配器（live 触发/轮询）+ metrics 按 model 归因 + live 真实复现验收 | 真实 run repro__m4-live-002__1（物理设备重启+bench 1656.78s）→reproduced（1/1 signature_match=true）；triage env/0.8、review approve、metrics 归因；时帽 ledger 实测 | 116 |

## M4 live 验收证据（2026-11-20，用户授权触发）

- 真实 Airflow run `repro__m4-live-002__1`（DAG `test_flash_attention_flow`，失败任务 `run_4-wait-ready`）在物理设备 gfx1151-qcf（Strix Halo）上重启+bench，耗时 **1656.78s** → failed。
- verdict **reproduced**（1/1 failed，signature_match=true）；真实日志签名基线 = `TimeoutError: Flash-Attention server not ready within 900s`（`4-wait-ready.py:65`，exit 1）。
- triage 真实分类 **env / confidence 0.8**（vLLM APIServer 启动崩溃 `AmbiguousGlobalPerLayerAttributeError on head_dim`）；review **approve**（异构 pro 模型）。
- metrics.llm 按 model 归因：router×2 / triage / ticket = deepseek-v4-flash，review = deepseek-v4-pro（token null，见 D17）。
- 时帽 ledger 实测生效（last_hour 计数 + 10/h 硬拒）。

### live 实测发现并修复的 bug

| 编号 | 问题 | 修复 |
|---|---|---|
| **D18 修正** | Airflow 3.3.1 日志响应键是 `{content:[{event}]}` 而非初设 `{logs:[…]}`；旧键提取空串 → 签名"空对空"vacuous 匹配 | extractLogTail 优先 content、兼容 logs；离线对真实 run 重算得有效签名（baseline==rerun，签名与 run_ref 无关） |
| **D19** | routerAccept 原仅传 verdict+reason，Router 凭入口记忆（input 无 signature）误判证据缺口而拒绝验收 | 传真实复现证据（attempts/failed_attempts/signature_match_count/per-rerun signature_match + baseline_source）+ prompt 说明基线在 reproFinalize 从原始 run 日志算；对真实 m4-live-002 证据离线验证 accepted=true；e2e-m3 增 acceptance_rejected=false 回归断言 |
| **D20** | metrics CLI guard 在 `process.argv[1]` undefined（tsx -e 导入上下文）致 pathToFileURL 崩溃 | guard 增 argv[1] 存在性判断 |

> `m4-live-001` 为修复前 vacuous 匹配 / Router 拒绝的历史工件，保留作护栏（D8 Router 关闭咨询）履职证据。

## 决策日志

| 编号 | 决策 | 状态 |
|---|---|---|
| D2 | 护栏契约 G1–G11 作为 v3 新契约签认 | 已确认（2026-11-19） |
| D5 | 凭据落盘 + provider 切换（Airflow 顶替 Jenkins，Jira/Azure mock） | 已提供（2026-11-19） |
| D6 | 初期不建 coordinator | 已确认（2026-11-19） |
| **D7** | **底盘裁决（V2 autoloop vs V3 Temporal）** | **继续开放平行**：两分支各自推进，待验收数据后裁决；V3 M1–M4 数据已齐，V2 尚未落地 |
| D8 | Router 两处咨询点（入口 dispatch + 关闭 acceptance） | 已确认（2026-11-19） |
| D9/D10 | 角色降级 / 会话外置 resume-per-call | 已确认（2026-11-19） |
| D11 | 跳步窗口 7d + conf 哈希一致 + 仅 reproduced 历史，默认 off | 已确认（2026-11-19） |
| D14 | M4 live 授权边界：先建适配器+mock，切 live/真实触发前单独确认 | 已确认（2026-11-20）；用户已授权 live 触发 |
| D15 | failed_tasks/签名基线对齐真实 DAG（真实失败任务=run_4-wait-ready） | 已确认（2026-11-20） |
| D16 | verdict 覆盖：reproduced 实测；flaky/not_reproduced 用 dry_run 矩阵佐证并注明限制 | 已确认（2026-11-20） |
| D17 | Strix Halo 对照延后；本阶段 proxy-only（usage 零→token null） | 已确认（2026-11-20） |
| D18 | Airflow 日志提取键 | 已确认并修正（2026-11-20，content 非 logs） |
| D19 | Router 关闭验收证据可见性 | 已确认并修复（2026-11-20） |
| D20 | metrics CLI guard 健壮性 | 已修复（2026-11-20） |

## 已知限制

- **D16**：真实 DAG `test_flash_attention_flow` 恒败，live 无法产出 flaky/not_reproduced；这两态以 dry_run 矩阵佐证（e2e-dryrun/e2e-matrix），验收记录注明此限制。
- **D17**：LLM 角色走 qoder-proxy，usage 返回零 → metrics token 为 null；Strix Halo 本地 vLLM 真实 token 对照延后。
- **D7**：底盘未裁决；V2（autoloop）分支尚未落地，V3 为当前唯一运行实现。裁决前不写共享底盘结论。

## 下一步

- D7 底盘裁决待用户决定；裁决后由用户指定的整合会话**按 diff 合并胜出分支**，落败分支归档不删除。
- 可选后续：Strix Halo 真实 token 对照（D17）、V2 分支落地、真实 Jira/Azure 接入（当前 mock，接真实系统前须改 live 并填凭据 + 用户确认）。