export interface CaseInput {
  schema_version: '3.0';
  incident_id: string;
  source: string;
  ci: {
    provider: 'airflow' | 'jenkins';
    base_url: string;
    dag_id?: string;
    job_id?: string;
    run_ref: string;
    failed_tasks: string[];
  };
  signature?: string;
  evidence_refs?: { log_urls?: string[]; pr?: string; config_rev?: string };
  policy?: { max_reruns?: number; timeout_minutes?: number; hourly_rerun_cap?: number };
  dry_run_scenario?: 'stable_fail' | 'flaky' | 'all_pass' | 'paused' | 'timeout';
  issued_at: string;
}

export interface EffectivePolicy {
  max_reruns: number;
  timeout_minutes: number;
  hourly_rerun_cap: number;
  max_rework: number;
}

export interface TriageSlice {
  classification: 'driver' | 'test' | 'env' | 'infra' | 'code' | 'unknown';
  confidence: number;
  summary: string;
  suspected_root_cause?: string;
  qualifies_for_reproduction: boolean;
}

export interface CiFact {
  attempt: number;
  run_ref: string;
  state: 'failed' | 'success' | 'running' | 'queued' | 'abandoned';
  log_tail?: string;
  duration_seconds?: number;
}

export interface ReproSlice {
  verdict: 'reproduced' | 'flaky' | 'not_reproduced' | 'inconclusive' | 'skipped' | 'error';
  verdict_reason: string;
  attempts: number;
  failed_attempts: number;
  signature_match_count: number;
  rate?: number;
  reruns: Array<{
    attempt: number;
    run_ref: string;
    state: CiFact['state'];
    signature_match?: boolean;
    duration_seconds?: number;
  }>;
  abandoned_run_refs?: string[];
  history_match?: { reused_case_id: string; matched_at?: string; original_verdict?: string };
}

export interface TicketSlice {
  draft: {
    title: string;
    priority: 'low' | 'medium' | 'high';
    component: string;
    assignee_hint?: string;
  };
  duplicate_of_case?: string | null;
  external_ticket_ref?: string;
}

export interface ReviewSlice {
  decision: 'approve' | 'reject' | 'need_info';
  checks?: { diagnosis?: boolean; evidence?: boolean; reproducibility?: boolean; duplicate?: boolean };
  reason: string;
}

export interface CaseClose {
  schema_version: '3.0';
  incident_id: string;
  verdict: ReproSlice['verdict'];
  state: 'closed' | 'dead';
  ticket_ref?: string;
  evidence_dir: string;
  metrics: {
    tat_seconds: number;
    stages: Record<string, number>;
    llm?: Array<{
      role: string;
      model: string;
      turns: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }>;
    reruns_triggered: number;
    history_skip: boolean;
  };
  lesson_ref?: string;
}