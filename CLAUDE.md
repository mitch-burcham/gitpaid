# GitPaid

Fork of [sirdeggen/crowd](https://github.com/sirdeggen/crowd) (N-of-M BSV multisig escrow, browser-only). GitPaid adds: (1) overlay broadcast of escrows for global discovery, (2) an MV3 browser extension that injects bounty UI into GitHub issue pages. Keep `upstream` mergeable — don't fork escrow-engine semantics (`src/lib/CrowdEscrow.ts`, `escrow.ts`, `protocol.ts`, `store.ts`) without an ADR.

## Alpha Code Framework — artifacts live in the wiki

This project's BRD, PRD, TRD, RTM, ADRs, and postmortems live at:
`~/wiki/companies/binary/projects/gitpaid/`

- Operational framework: `~/wiki/concepts/ai-native-product-lifecycle.md`
- RTM is the spine — anything not in the RTM does not exist. Use `/alpha-code` to scaffold or maintain.
- **After any gstack review/ship/qa skill, run `/alpha-code rtm-update`** to reconcile findings into RTM rows.
- All rows currently `status: inferred` (adopted 2026-06-11) — approval queue at `~/wiki/companies/binary/projects/gitpaid/INFERRED-FOR-REVIEW.md`.

## Prior art

`/Users/donot/Misc/metanet-projects/gitpaidv3` — superseded prototype. Mine it for patterns (BountyTopicManager/BountyLookupService overlay, GitHub content-script suite, dom-retry), not code.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
