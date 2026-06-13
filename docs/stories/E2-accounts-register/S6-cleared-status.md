# Story E2.S6: Cleared / uncleared status and balance split

Status: ready-for-dev

## Story

As Calvin, I want each transaction to carry a cleared/uncleared/reconciled state with the account showing cleared vs working balances, so that I can see what the bank has confirmed versus what I've entered ahead of it.

## Context

Three-state lifecycle per transaction: `uncleared → cleared → reconciled` (reconciled is set only by the reconciliation flow, E2.S7). Cleared balance = starting balance + sum of cleared and reconciled rows; working balance includes everything. Imported rows from the bank arrive cleared (they are bank-confirmed); manual rows default to uncleared.

## Acceptance Criteria

- **AC-1** Given a transaction in the register, when its cleared flag is toggled, then its amount moves between the account's uncleared and cleared balance figures immediately. *(FR-17)*
- **AC-2** Given an account header, then working balance and cleared balance are both displayed and each equals the corresponding sum over its transactions plus starting balance. *(FR-17, FR-12, NFR-12)*
- **AC-3** Given a reconciled transaction, when a cleared-status toggle is attempted, then it requires explicit confirmation (reconciled rows are locked by default). *(FR-18)*
- **AC-4** Given the cleared toggle, then it is operable from the keyboard within the register row. *(NFR-9)*
- **AC-5** Given a transaction created by a bank import (Plaid or file), then it arrives with status `cleared`; manual entries default to `uncleared`. *(FR-17, architecture §6)*

## Dev Notes

- Status column on the transaction row: `uncleared|cleared|reconciled`. Balances derived on read, never stored. [ADR-005]
- The reconciled-edit confirmation behavior is asserted again in E2.S7; implement the lock here so S7 only adds the flow.

## Out of Scope

- The reconciliation flow itself (E2.S7), Plaid pending→posted nuance (raw payload concern, E5.S2).

## References

- [Source: docs/prd.md#FR-17] · [Source: docs/prd.md#FR-12]
- [Source: docs/architecture.md#5-domain-model--budget-math]
- [Source: docs/adr/ADR-005]
