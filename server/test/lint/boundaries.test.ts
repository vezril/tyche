import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

// AC-5 of E1.S1: module-boundary rules (ADR-001) and the money rule (ADR-004)
// are enforced by lint, and a violation FAILS the build. These tests run the
// real repo eslint config against in-memory violating files.

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: REPO_ROOT });

async function ruleIdsFor(code: string, relativePath: string): Promise<(string | null)[]> {
  const results = await eslint.lintText(code, { filePath: join(REPO_ROOT, relativePath) });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId));
}

describe('module boundaries (ADR-001)', () => {
  it('budget importing from importing fails lint', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../importing/index.js';\n",
      'server/src/budget/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('budget importing from web fails lint', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../web/app.js';\n",
      'server/src/budget/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('importing importing from budget fails lint (FR-25 provenance seam)', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../budget/index.js';\n",
      'server/src/importing/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('importing may import the ledger command interface (allowed seam)', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../ledger/index.js';\n",
      'server/src/importing/allowed.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  it('migration may import budget AND ledger (E6: assignments + ledger writes)', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../budget/index.js';\nimport '../ledger/index.js';\n",
      'server/src/migration/allowed.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  it('migration importing from importing/web fails lint (E6: standalone backend)', async () => {
    for (const target of ['importing/index.js', 'web/app.js']) {
      const ruleIds = await ruleIdsFor(
        `import '../${target}';\n`,
        'server/src/migration/violation.ts',
      );
      expect(ruleIds, `migration must not import ${target}`).toContain('no-restricted-imports');
    }
  });

  it('budget importing from migration fails lint (FR-25 provenance seam)', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../migration/index.js';\n",
      'server/src/budget/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('crypto importing from any domain module fails lint (E1.S3: leaf module)', async () => {
    for (const target of ['admin/settings.js', 'auth/index.js', 'db/connection.js']) {
      const ruleIds = await ruleIdsFor(
        `import '../${target}';\n`,
        'server/src/crypto/violation.ts',
      );
      expect(ruleIds, `crypto must not import ${target}`).toContain('no-restricted-imports');
    }
  });

  it('importing may use the crypto module (E5 encrypts access tokens with it)', async () => {
    const ruleIds = await ruleIdsFor(
      "import '../crypto/index.js';\n",
      'server/src/importing/allowed.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  it('budget importing shared types is allowed', async () => {
    const ruleIds = await ruleIdsFor(
      "import type { Milliunits } from '@ynab-clone/shared';\nexport type X = Milliunits;\n",
      'server/src/budget/allowed.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });
});

describe('money rule (ADR-004): no float arithmetic outside the audited utils module', () => {
  it('multiplication in a domain module fails lint', async () => {
    const ruleIds = await ruleIdsFor(
      'export const x = (a: number, b: number): number => a * b;\n',
      'server/src/budget/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('division in a domain module fails lint', async () => {
    const ruleIds = await ruleIdsFor(
      'export const x = (a: number, b: number): number => a / b;\n',
      'server/src/ledger/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('float literals in a domain module fail lint', async () => {
    const ruleIds = await ruleIdsFor(
      'export const rate = 0.5;\n',
      'server/src/importing/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('the money rule covers the migration module too (E6, FR-32)', async () => {
    const ruleIds = await ruleIdsFor(
      'export const cents = (m: number): number => m / 10;\n',
      'server/src/migration/violation.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('addition on money in a domain module is allowed', async () => {
    const ruleIds = await ruleIdsFor(
      'export const x = (a: number, b: number): number => a + b;\n',
      'server/src/budget/allowed.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('the audited money module itself is exempt', async () => {
    const ruleIds = await ruleIdsFor(
      'export const cents = (m: number): number => m / 10;\n',
      'shared/src/money.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });
});
