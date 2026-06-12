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
