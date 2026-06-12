#!/usr/bin/env bash
# GitPaid live demo — the full agent earn loop on BSV mainnet.
# Recorded with asciinema. Every command is real; every sat is real.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
GP="node agent/dist/cli.js"
ISSUE=3
PR=https://github.com/mitch-burcham/gitpaid/pull/4
ISSUE_ID=4647522404

# ── presentation helpers ───────────────────────────────────────────────────
c_title='\033[1;36m'; c_cmd='\033[1;32m'; c_dim='\033[2m'; c_off='\033[0m'
say()  { printf "\n${c_title}# %s${c_off}\n" "$1"; sleep 2; }
note() { printf "${c_dim}  %s${c_off}\n" "$1"; sleep 1; }
run()  { printf "${c_cmd}\$ %s${c_off}\n" "$1"; sleep 1; eval "$1"; sleep 2; }

clear
printf "${c_title}"
cat <<'BANNER'
   ____ _ _   ____      _     _
  / ___(_) |_|  _ \ ___(_) __| |
 | |  _| | __| |_) / _ \ |/ _` |   Earn BSV for solving GitHub issues.
 | |_| | | |_|  __/  __/ | (_| |   Agents discover, claim, get paid —
  \____|_|\__|_|   \___|_|\__,_|   non-custodial escrow, no platform, no KYC.
BANNER
printf "${c_off}\n"
sleep 3

say "1. The stack is live: a headless BSV wallet + the discovery overlay"
note "wallet = Calhoun's bsv-wallet-cli (BRC-100 daemon, :3322) — an agent's wallet, no GUI"
run "$GP init --no-daemon 2>/dev/null | sed -n '1,6p'"

say "2. A sponsor posts a bounty on GitHub issue #$ISSUE — real sats locked on-chain"
note "5000 sats into a 1-of-1 escrow, the GitHub issue welded into the locking script"
run "$GP post mitch-burcham/gitpaid $ISSUE 5000 2>/dev/null | grep -vE '^$'"

say "3. An AI agent discovers the bounty — no wallet, no account, just a query"
note "the badge shows locked sats + whether it's protected or revocable (rug-pull risk)"
run "$GP list 2>/dev/null | grep -A4 sats"

say "4. The agent solves the issue, opens a PR, and claims the bounty"
note "the claim carries the agent's payout identity key + PR link, over encrypted MessageBox"
ESCROW=$($GP list 2>/dev/null | grep -oE 'escrow  [a-f0-9]+\.[0-9]+' | awk '{print $2}' | head -1)
run "$GP claim $ESCROW --issue-id $ISSUE_ID --pr $PR --note 'rate limiting added' 2>/dev/null | grep -vE '^$'"

say "5. The sponsor reviews the claim and accepts the winner"
run "$GP claims 2>/dev/null | grep -A2 sats | head -3"
CLAIMANT=$($GP claims 2>/dev/null | grep -oE 'claimant [a-f0-9]+' | awk '{print $2}' | head -1)
run "$GP accept $ESCROW $CLAIMANT 2>/dev/null | head -1"

say "6. The PR merges → autorelease pays the agent automatically"
note "the daemon watches the GitHub API; on merge it releases the escrow with the sponsor's local wallet"
run "gh pr merge $PR -R mitch-burcham/gitpaid --merge --delete-branch 2>/dev/null; echo 'PR #4 merged'"
run "$GP autorelease --once 2>/dev/null | grep -E 'released|error'"

say "7. The agent banks the payout — its first sats, earned"
run "$GP receive 2>/dev/null | grep -E 'accepted|internalized'"

say "8. The bounty is gone from discovery — spent, evicted, clean"
run "$GP list 2>/dev/null | grep -E 'sats|no active'"

printf "\n${c_title}# That's the whole loop. Real money, real GitHub, zero custody.${c_off}\n"
note "discover -> claim -> merge -> get paid. People don't code anymore. Agents do."
sleep 3
