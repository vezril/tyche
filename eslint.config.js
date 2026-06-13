import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint = the build's boundary enforcer (AC-5 of E1.S1).
 *
 * 1. Module boundaries (ADR-001, architecture §2): domain modules live in
 *    server/src/<module>/ and may only depend on what the matrix below allows.
 *    Notably: budget never imports importing (FR-25 — budget math must not
 *    know a transaction's provenance) and importing reaches ledger only via
 *    its public command interface.
 *
 * 2. Money rule (ADR-004): no `*`, `/`, `%`, `**` and no float literals in
 *    domain modules — milliunit amounts are integers manipulated with +/-.
 *    The single audited exception is shared/src/money.ts.
 *
 * Violations are errors, so `npm run lint` (CI / pre-release) fails the build.
 */

/** Forbid imports that cross a module boundary. */
function moduleBoundary(module, forbidden) {
  return {
    files: [`server/src/${module}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbidden.map((target) => ({
            group: [`**/${target}`, `**/${target}/**`],
            message: `ADR-001 module boundary: '${module}' must not import from '${target}'.`,
          })),
        },
      ],
    },
  };
}

const NO_FLOAT_MATH = {
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "BinaryExpression[operator='*']",
        message:
          'ADR-004 money rule: no multiplication in domain modules — use the audited helpers in shared/src/money.ts.',
      },
      {
        selector: "BinaryExpression[operator='/']",
        message:
          'ADR-004 money rule: no division in domain modules — use the audited helpers in shared/src/money.ts.',
      },
      {
        selector: "BinaryExpression[operator='%']",
        message:
          'ADR-004 money rule: no modulo in domain modules — use the audited helpers in shared/src/money.ts.',
      },
      {
        selector: "BinaryExpression[operator='**']",
        message:
          'ADR-004 money rule: no exponentiation in domain modules — use the audited helpers in shared/src/money.ts.',
      },
      {
        selector: String.raw`Literal[raw=/^[0-9]*\.[0-9]+$/]`,
        message:
          'ADR-004 money rule: no float literals in domain modules — amounts are integer milliunits.',
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- ADR-001 module-boundary matrix -----------------------------------
  moduleBoundary('budget', ['importing', 'migration', 'auth', 'admin', 'web']),
  moduleBoundary('ledger', ['budget', 'importing', 'migration', 'auth', 'admin', 'web']),
  moduleBoundary('importing', ['budget', 'migration', 'auth', 'admin', 'web']),
  // migration (E6) is the one importer backend that may ALSO write month
  // assignments, so it sits beside importing/ and may use budget + ledger.
  moduleBoundary('migration', ['importing', 'auth', 'admin', 'web']),
  moduleBoundary('auth', ['budget', 'ledger', 'importing', 'migration', 'web']),
  moduleBoundary('admin', ['importing', 'migration', 'web']),
  moduleBoundary('db', ['budget', 'ledger', 'importing', 'migration', 'auth', 'admin', 'web']),
  // crypto (ADR-007 field encryption, E1.S3) is a leaf module: anyone may use
  // it (admin for the Plaid secret, importing for E5 access tokens); it
  // depends on nothing but node:crypto.
  moduleBoundary('crypto', ['budget', 'ledger', 'importing', 'migration', 'auth', 'admin', 'web', 'db']),
  // web (HTTP layer) may import everything — no entry needed.

  // --- ADR-004 money rule -------------------------------------------------
  {
    files: [
      'server/src/budget/**/*.ts',
      'server/src/ledger/**/*.ts',
      'server/src/importing/**/*.ts',
      'server/src/migration/**/*.ts',
      'server/src/admin/**/*.ts',
      'shared/src/**/*.ts',
    ],
    ignores: ['shared/src/money.ts'], // the ONE audited arithmetic module
    ...NO_FLOAT_MATH,
  },
);
