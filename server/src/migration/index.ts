/**
 * migration module (E6, FR-30/31): the YNAB migration backend. A sibling of
 * importing/ rather than a subdirectory because — unlike the other importer
 * backends — it must also write month assignments through the budget module,
 * which the importing module is forbidden to touch (FR-25 boundary). All
 * ledger writes still go through ledger/index.ts commands, so migrated rows
 * have identical budget effects to any other source (E6.S1 AC-4).
 *
 * This file is the module's ONLY public surface. Boundary rules (eslint):
 * migration never imports from auth/admin/web.
 */
export { MigrationError, type MigrationErrorCode } from './errors.js';
export {
  parsePlanCsv,
  parseRegisterCsv,
  parseYnabAmount,
  parseYnabDate,
  parseYnabMonth,
  type MigrationRowIssue,
  type ParsedPlan,
  type ParsedRegister,
  type PlanRow,
  type RegisterRow,
} from './parse.js';
export { runMigration, type RunMigrationInput } from './migrate.js';
