import { Connection, Client, WorkflowIdReusePolicy, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { caseWorkflow } from '../workers/src/case.workflow';
import { cfg, workDir, fakeCiUrl } from '../workers/src/config';
import { checkSource, checkIngestRate } from '../workers/src/admission';
import { assertValid, validateCaseInput } from '../workers/src/validate';
import { failureSignature } from '../shared/signature';
import type { CaseInput } from '../workers/src/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const scenario = (arg('scenario', 'stable_fail') ?? 'stable_fail') as CaseInput['dry_run_scenario'];
  const incident = arg('incident', `inc-${Date.now()}`)!;
  const input: CaseInput = {
    schema_version: '3.0',
    incident_id: incident,
    source: arg('source', 'simulator')!,
    ci: {
      provider: 'airflow',
      base_url: process.env.AIRFLOW_BASE_URL ?? 'http://172.31.0.2:8080',
      dag_id: 'test_flash_attention_flow',
      run_ref: process.env.IQE_KNOWN_FAILED_REF ?? 'manual__2026-11-03T06:57:10.329997+00:00',
      failed_tasks: (arg('failed-tasks', 'run_kernel_test') ?? 'run_kernel_test').split(',').map((s) => s.trim()).filter(Boolean),
    },
    policy: { timeout_minutes: Number(arg('timeout', '30')), ...(arg('max-reruns') ? { max_reruns: Number(arg('max-reruns')) } : {}) },
    dry_run_scenario: scenario,
    issued_at: new Date().toISOString(),
  };
  const configRev = arg('config-rev');
  if (configRev) input.evidence_refs = { config_rev: configRev };
  try {
    const res = await fetch(`${fakeCiUrl()}/original-log`);
    if (res.ok) input.signature = failureSignature(input.ci.failed_tasks, await res.text());
  } catch {
    // signature optional; history skip stays disabled without it
  }
  assertValid(validateCaseInput, input, 'case-input');

  const src = checkSource(input.source, cfg.sourceAllowlist);
  if (!src.ok) {
    console.error(`[inject] rejected: ${src.reason}`);
    process.exit(4);
  }
  const rate = checkIngestRate(workDir(), cfg.ingestHourlyCap, Date.now());
  if (!rate.ok) {
    console.error(`[inject] rejected: ${rate.reason}`);
    process.exit(4);
  }

  const connection = await Connection.connect({ address: cfg.temporalAddress });
  const client = new Client({ connection, namespace: cfg.namespace });
  try {
    const handle = await client.workflow.start(caseWorkflow, {
      taskQueue: 'iqe.case',
      workflowId: incident,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      args: [input],
    });
    console.log(`[inject] started workflow ${handle.workflowId}`);
    if (process.argv.includes('--no-wait')) return;
    const result = await handle.result();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      console.log(`[inject] duplicate incident ${incident}: workflow already exists (dedup OK)`);
      process.exitCode = 3;
      return;
    }
    throw e;
  } finally {
    await connection.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});