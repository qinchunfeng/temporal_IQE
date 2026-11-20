import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { cfg } from './config';

export const QUEUES = ['iqe.case', 'iqe.router', 'iqe.triage', 'iqe.repro', 'iqe.ticket', 'iqe.review', 'iqe.reporting'];

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createWorkers(connection: NativeConnection): Promise<Worker[]> {
  return Promise.all(
    QUEUES.map((taskQueue) =>
      Worker.create({
        connection,
        namespace: cfg.namespace,
        taskQueue,
        activities,
        ...(taskQueue === 'iqe.case' ? { workflowsPath: path.join(here, 'case.workflow.ts') } : {}),
      }),
    ),
  );
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address: cfg.temporalAddress });
  const workers = await createWorkers(connection);
  console.log(`[iqe-v3] ${workers.length} workers up (mode=${cfg.mode}, namespace=${cfg.namespace})`);
  const shutdown = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.shutdown()));
    await connection.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await Promise.all(workers.map((w) => w.run()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}