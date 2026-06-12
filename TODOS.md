# TODOS

## TODO-001 — Upstream PR: sender validation in Crowd's store reduce()
- **What:** Contribute sender-validation to sirdeggen/crowd — `reduce()` applies `cancelled`/`finalized` with no sender checks (`src/lib/store.ts:128-168`); `cancelled` should require the originator, `finalized` should verify the txid spends the escrow.
- **Why:** Real upstream bug (low exposure there since escrowIds are private; high exposure here since the overlay publishes them). Upstreaming eventually lets GitPaid drop its defensive inbox wrapper.
- **Pros:** One validation implementation across both projects; good-citizen fork relationship.
- **Cons:** Upstream review latency; rules may diverge from what GitPaid needs.
- **Context:** GitPaid ships its own sender-validating inbox wrapper regardless (eng review D-series, 2026-06-11). This TODO is the contribute-back step.
- **Depends on:** GitPaid wrapper shipped and rules proven.

## TODO-002 — Funder GitHub-handle attestation in binding data (v1.1)
- **What:** Optional signed claim "funded by GitHub user X" in the escrow binding, verifiable via gist/comment challenge; badge shows verified funder.
- **Why:** Raises rug-pull cost (outside-voice P1-5). v1 already discloses `revocable` vs `protected`; this adds funder reputation.
- **Pros:** Strong anti-spoof signal exactly where hunters decide to engage.
- **Cons:** GitHub-proof subsystem (challenge flow, revocation) — real scope.
- **Context:** Binding codec must carry a version byte from day one so this field slots in without re-indexing (decided 2026-06-11).
- **Depends on:** v1 shipped; codec versioned (in v1 scope).

## TODO-003 — Wedge experiment: install→wallet→claim funnel (route to /plan-ceo-review)
- **What:** Cheapest funnel test — seed ~5 bounties on one recruited repo, measure extension-install → wallet-running → claim conversion.
- **Why:** The ext + Metanet Desktop + funded-BSV funnel is unvalidated (outside-voice P1-9); full v1 surface is being built on founder conviction.
- **Pros:** Converts the riskiest assumption into data for the PSF gate.
- **Cons:** Needs a willing repo + seeded sats.
- **Context:** Strategic, not eng — belongs to `/plan-ceo-review` + `/alpha-code path-to-revenue`. Eng scope stays full-v1 per D2 (2026-06-11).
- **Depends on:** Anything installable (post first extension build).

## TODO-004 — Agent reputation per identity key (P2, deferred at CEO review D15)
- **What:** `findByIdentityKey` aggregation on the lookup node (claims made, bounties won, sats earned), surfaced in sponsor claim lists ("this agent completed 14 bounties").
- **Why:** Claim-spam's eventual fix + the sponsor's selection signal when multiple agents claim.
- **Pros:** Read-only aggregation over data the node already stores; directly monetizable signal later.
- **Cons:** Reputation-gaming surface; premature before claim volume exists.
- **Context:** Deferred 2026-06-12 (CEO review, agent-first pivot). v1 claim lists show PR links + GitHub state only; per-identity claim cap (FR-016) bounds spam until then.
- **Effort:** M (human) → S (CC). **Depends on:** real claim volume.

## TODO-005 — x402-style HTTP discovery bridge (P3)
- **What:** Paid HTTP endpoint speaking the emerging agent-payment protocols (x402 / MPP / AP2), bridging to `ls_gitpaid` for programmatic bounty discovery.
- **Why:** Meets agents on the rails the industry is converging on (Stripe, Coinbase, Google all shipping in 2026).
- **Pros:** Distribution into every x402-capable agent stack.
- **Cons:** Protocol race unsettled — wrong horse = wasted bridge.
- **Context:** Captured 2026-06-12 with a named trigger: re-evaluate when one protocol clearly wins. v1 discovery = npm CLI/MCP + overlay polling.
- **Effort:** M. **Depends on:** v1 shipped + protocol convergence.
