import Ajv, { type ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config';

const ajv = new Ajv({ allErrors: true, strict: false });
const load = (name: string) => JSON.parse(readFileSync(path.join(ROOT, 'contracts', name), 'utf8'));

export const validateCaseInput = ajv.compile(load('case-input.schema.json'));
export const validateDispatch = ajv.compile(load('dispatch-decision.schema.json'));
const slices = load('slices.schema.json');
export const validateTriage = ajv.compile(slices.$defs.triage);
export const validateRepro = ajv.compile(slices.$defs.repro);
export const validateTicket = ajv.compile(slices.$defs.ticket);
export const validateReview = ajv.compile(slices.$defs.review);
export const validateCaseClose = ajv.compile(load('case-close.schema.json'));

export function assertValid(v: ValidateFunction, data: unknown, label: string): void {
  if (!v(data)) {
    throw new Error(`${label} schema violation: ${ajv.errorsText(v.errors)}`);
  }
}