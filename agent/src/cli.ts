#!/usr/bin/env node
/**
 * gitpaid — agent CLI (FR-019/FR-023).
 *
 * Hunter loop: init → list/watch → claim → status → get paid.
 * Wallet: bsv-wallet-cli daemon over BRC-100 HTTP, :3322 (ADR-004).
 * Discovery is wallet-less; only claim/status need the daemon (BR-007).
 *
 * SR-008 note: slugs/notes/PR URLs are third-party data. The CLI prints
 * them inside «guillemets» so terminal output makes the trust boundary
 * visible to both humans and any agent reading stdout.
 */
import { Command } from 'commander'
import { spawn, spawnSync } from 'node:child_process'
import { WalletClient, HTTPWalletJSON, Utils } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { BINDING_VERSION } from '@engine/binding'
import {
  createGitPaidEscrow, releaseSoloBounty, submitToOverlay, GITPAID_BOX,
  type GitPaidInvite,
} from '@engine/gitpaidEscrowOps'
import { GitPaidAgentClient, DEFAULT_WALLET_URL, type BountyInfo } from './core.js'
import { runMcpServer } from './mcp.js'
import { buildSponsorState, type AcceptMsg, type SponsorState } from './sponsor.js'
import { runAutoreleaseOnce } from './autorelease.js'

const OVERLAY_URL = process.env.GITPAID_OVERLAY_URL ?? 'http://localhost:8080'
const WALLET_URL = process.env.GITPAID_WALLET_URL ?? DEFAULT_WALLET_URL
const MESSAGEBOX_HOST = process.env.GITPAID_MESSAGEBOX_HOST ?? 'https://gmb.bsvblockchain.tech'
const WALLET_INSTALL_HINT =
  'bsv-wallet not found. Install it (Calhooon/bsv-wallet-cli):\n' +
  '  curl -sSf https://raw.githubusercontent.com/Calhooon/bsv-wallet-cli/main/install.sh | sh\n' +
  'or: cargo install --git https://github.com/Calhooon/bsv-wallet-cli.git'

function makeWallet (): WalletClient {
  // HTTPWalletJSON requires the originator on ITS constructor in Node
  return new WalletClient(new HTTPWalletJSON('gitpaid-agent.local', WALLET_URL))
}

function makeClient (withWallet: boolean): GitPaidAgentClient {
  if (!withWallet) return new GitPaidAgentClient({ overlayUrl: OVERLAY_URL })
  const wallet = makeWallet()
  const mbx = new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST })
  return new GitPaidAgentClient({ overlayUrl: OVERLAY_URL, wallet, mbx })
}

/** «quote» third-party text and strip control characters (SR-008). */
function untrusted (s: string): string {
  // eslint-disable-next-line no-control-regex
  return `«${s.replace(/[\u0000-\u001f\u007f]/g, '\uFFFD')}»`
}

function formatBounty (b: BountyInfo): string {
  const flag = b.protection === 'protected' ? 'PROTECTED' : 'REVOCABLE'
  return [
    `${b.satoshis} sats  [${flag} ${b.threshold}-of-${b.total}]`,
    `  issue   ${untrusted(b.untrusted.slug)} #${b.issueNumber}  (repoId ${b.repoId}, issueId ${b.issueId})`,
    `  escrow  ${b.escrowId}`,
    `  funder  ${b.funderIdentityKey}`,
  ].join('\n')
}

async function walletReachable (): Promise<boolean> {
  try {
    await makeWallet().getVersion({})
    return true
  } catch {
    return false
  }
}

const program = new Command()
program
  .name('gitpaid')
  .description('Earn BSV for solving GitHub issues — agent CLI for the GitPaid bounty overlay')
  .version('0.1.0')

program
  .command('init')
  .description('Provision the agent wallet (bsv-wallet-cli) and verify reachability — ready-to-hunt in minutes, zero sats needed')
  .option('--no-daemon', 'skip starting the wallet daemon')
  .action(async (opts: { daemon: boolean }) => {
    // 1. bsv-wallet binary (ADR-004). v0.2.x has no --version; probe --help.
    const probe = spawnSync('bsv-wallet', ['--help'], { encoding: 'utf8' })
    if (probe.error !== undefined) {
      console.error(WALLET_INSTALL_HINT)
      process.exitCode = 1
      return
    }
    console.log('bsv-wallet found')

    // 2. wallet db init (idempotent upstream) + daemon
    if (!(await walletReachable())) {
      spawnSync('bsv-wallet', ['init'], { stdio: 'inherit' })
      if (opts.daemon) {
        const daemon = spawn('bsv-wallet', ['daemon'], { detached: true, stdio: 'ignore' })
        daemon.unref()
        process.stdout.write('starting wallet daemon')
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 1000))
          process.stdout.write('.')
          if (await walletReachable()) break
        }
        process.stdout.write('\n')
      }
    }
    if (!(await walletReachable())) {
      console.error(`wallet daemon not reachable at ${WALLET_URL} — start it with: bsv-wallet daemon`)
      process.exitCode = 1
      return
    }

    // 3. identity + reachability checks
    const { publicKey } = await makeWallet().getPublicKey({ identityKey: true })
    console.log(`wallet     OK  ${WALLET_URL}`)
    console.log(`identity   ${publicKey}`)

    try {
      const res = await fetch(`${OVERLAY_URL}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'ls_gitpaid', query: { type: 'findAllActive' } }),
      })
      console.log(`overlay    ${res.ok ? 'OK ' : `HTTP ${res.status} `} ${OVERLAY_URL}`)
    } catch {
      console.log(`overlay    UNREACHABLE  ${OVERLAY_URL}  (set GITPAID_OVERLAY_URL)`)
    }
    try {
      const res = await fetch(MESSAGEBOX_HOST)
      console.log(`relay      ${res.ok || res.status < 500 ? 'OK ' : `HTTP ${res.status} `} ${MESSAGEBOX_HOST}`)
    } catch {
      console.log(`relay      UNREACHABLE  ${MESSAGEBOX_HOST}`)
    }

    // 4. MCP snippet — hunting needs zero sats (BR-007)
    console.log('\nready to hunt — no funding required; your first sats arrive by earning.')
    console.log('\nMCP config (Claude Code: paste into .mcp.json):')
    console.log(JSON.stringify({
      mcpServers: {
        gitpaid: {
          command: 'gitpaid',
          args: ['mcp'],
          env: { GITPAID_OVERLAY_URL: OVERLAY_URL, GITPAID_WALLET_URL: WALLET_URL },
        },
      },
    }, null, 2))
  })

program
  .command('list')
  .description('List active bounties (wallet-less)')
  .option('--repo <slug>', 'filter by owner/repo slug')
  .option('--repo-id <id>', 'filter by GitHub numeric repository ID')
  .option('--issue-id <id>', 'filter by GitHub numeric issue ID')
  .option('--issue <n>', 'filter by issue number (with --repo or --repo-id)')
  .action(async (opts: { repo?: string, repoId?: string, issueId?: string, issue?: string }) => {
    const client = makeClient(false)
    let bounties: BountyInfo[]
    if (opts.issueId !== undefined || opts.issue !== undefined) {
      bounties = await client.listByIssue({
        issueId: opts.issueId !== undefined ? Number(opts.issueId) : undefined,
        repoId: opts.repoId !== undefined ? Number(opts.repoId) : undefined,
        slug: opts.repo,
        issueNumber: opts.issue !== undefined ? Number(opts.issue) : undefined,
      })
    } else if (opts.repo !== undefined || opts.repoId !== undefined) {
      bounties = await client.listByRepo({
        repoId: opts.repoId !== undefined ? Number(opts.repoId) : undefined,
        slug: opts.repo,
      })
    } else {
      bounties = await client.listAllActive()
    }
    if (bounties.length === 0) {
      console.log('no active bounties')
      return
    }
    console.log(bounties.map(formatBounty).join('\n\n'))
  })

program
  .command('watch')
  .description('Poll for new bounties (30s interval)')
  .option('--repo <slug>', 'filter by owner/repo slug')
  .option('--interval <seconds>', 'poll interval', '30')
  .action(async (opts: { repo?: string, interval: string }) => {
    const client = makeClient(false)
    const seen = new Set<string>()
    const intervalMs = Math.max(5, Number(opts.interval)) * 1000
    console.log(`watching for bounties${opts.repo !== undefined ? ` in ${untrusted(opts.repo)}` : ''} (every ${intervalMs / 1000}s, ^C to stop)`)
    for (;;) {
      try {
        const bounties = opts.repo !== undefined
          ? await client.listByRepo({ slug: opts.repo })
          : await client.listAllActive()
        for (const b of bounties) {
          if (!seen.has(b.escrowId)) {
            seen.add(b.escrowId)
            console.log(`\n[${new Date().toISOString()}] NEW BOUNTY\n${formatBounty(b)}`)
          }
        }
      } catch (err) {
        console.error(`poll failed: ${err instanceof Error ? err.message : String(err)} — retrying`)
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
  })

program
  .command('claim <escrowId>')
  .description('Claim a bounty: send your identity key + PR link to the sponsor')
  .requiredOption('--pr <url>', 'URL of the pull request that resolves the issue')
  .requiredOption('--issue-id <id>', 'GitHub numeric issue ID of the bounty')
  .option('--note <text>', 'short note to the sponsor', '')
  .action(async (escrowId: string, opts: { pr: string, issueId: string, note: string }) => {
    const client = makeClient(true)
    const candidates = await client.listByIssue({ issueId: Number(opts.issueId) })
    const bounty = candidates.find(b => b.escrowId === escrowId)
    if (bounty === undefined) {
      console.error(`escrow ${escrowId} is not an active bounty on issue ${opts.issueId}`)
      process.exitCode = 1
      return
    }
    const claim = await client.claim(bounty, opts.pr, opts.note)
    console.log(`claim sent to sponsor ${bounty.funderIdentityKey}`)
    console.log(`  escrow  ${claim.escrowId}`)
    console.log(`  payout key (yours)  ${claim.claimantIdentityKey}`)
  })

program
  .command('status')
  .description('Status of your claims: active / spent / unknown')
  .action(async () => {
    const client = makeClient(true)
    const rows = await client.status()
    if (rows.length === 0) {
      console.log('no claims yet — find work with `gitpaid list`')
      return
    }
    for (const { claim, escrow } of rows) {
      console.log(`${escrow.toUpperCase().padEnd(8)} ${claim.satoshis} sats  issueId ${claim.issueId} #${claim.issueNumber}  ${claim.escrowId}`)
      console.log(`         pr ${untrusted(claim.prUrl)}`)
    }
    console.log('\nspent = released or cancelled — check your wallet (bsv-wallet balance) for the payout.')
  })

program
  .command('mcp')
  .description('Run the GitPaid MCP server on stdio (for Claude-class agents)')
  .action(async () => {
    await runMcpServer(makeClient(true))
  })

// ── sponsor-side commands (FR-021/FR-022) ──────────────────────────────────

function makeMbx (wallet: WalletClient): MessageBoxClient {
  return new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST })
}

async function loadSponsorState (wallet: WalletClient): Promise<{ state: SponsorState, ownKey: string, mbx: MessageBoxClient }> {
  const mbx = makeMbx(wallet)
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  const messages = await mbx.listMessages({ messageBox: GITPAID_BOX })
  return { state: buildSponsorState(messages, publicKey), ownKey: publicKey, mbx }
}

/** Resolve immutable GitHub IDs for the binding (TR-007). */
async function resolveIssue (slug: string, issueNumber: number, ghToken?: string): Promise<{ repoId: number, issueId: number }> {
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(ghToken !== undefined ? { Authorization: `Bearer ${ghToken}` } : {}),
  }
  const repoRes = await fetch(`https://api.github.com/repos/${slug}`, { headers })
  if (!repoRes.ok) throw new Error(`GitHub repo lookup failed: HTTP ${repoRes.status}`)
  const repo = await repoRes.json() as { id: number }
  const issueRes = await fetch(`https://api.github.com/repos/${slug}/issues/${issueNumber}`, { headers })
  if (!issueRes.ok) throw new Error(`GitHub issue lookup failed: HTTP ${issueRes.status}`)
  const issue = await issueRes.json() as { id: number }
  return { repoId: repo.id, issueId: issue.id }
}

program
  .command('post <slug> <issueNumber> <satoshis>')
  .description('Post a bounty on a GitHub issue (sponsor): lock sats in escrow + broadcast to the overlay')
  .option('--controller <identityKey...>', 'additional controller identity keys (default: sponsor-only 1-of-1)')
  .option('--threshold <n>', 'signatures required to release (default 1)')
  .action(async (slug: string, issueNumber: string, satoshis: string, opts: { controller?: string[], threshold?: string }) => {
    const wallet = makeWallet()
    const { repoId, issueId } = await resolveIssue(slug, Number(issueNumber), process.env.GITPAID_GITHUB_TOKEN)
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })

    const invite = await createGitPaidEscrow({
      satoshis: Number(satoshis),
      threshold: Number(opts.threshold ?? 1),
      controllerIdentityKeys: opts.controller ?? [],
      binding: {
        version: BINDING_VERSION,
        repoId,
        issueId,
        issueNumber: Number(issueNumber),
        funderIdentityKey: publicKey,
        slug,
      },
    }, wallet)

    // Overlay admittance (FR-011) — the bounty becomes globally discoverable
    await submitToOverlay(OVERLAY_URL, Utils.toArray(invite.beef, 'hex'))

    // Durable record + controller invites, Crowd-style fan-out incl. self
    const mbx = makeMbx(wallet)
    const body = JSON.stringify(invite)
    for (const recipient of new Set([publicKey, ...invite.controllers])) {
      await mbx.sendMessage({ recipient, messageBox: GITPAID_BOX, body }).catch(() => {})
    }

    console.log(`bounty posted: ${invite.satoshis} sats on ${untrusted(slug)}#${issueNumber}`)
    console.log(`  escrow  ${invite.escrowId}`)
    console.log(`  ${invite.threshold}-of-${invite.controllers.length} ${invite.controllers.length >= 2 ? 'PROTECTED' : 'REVOCABLE'}`)
  })

program
  .command('claims')
  .description('List claims received on your bounties (sponsor)')
  .action(async () => {
    const { state } = await loadSponsorState(makeWallet())
    if (state.claims.length === 0) {
      console.log('no claims received')
      return
    }
    for (const c of state.claims) {
      const accepted = state.accepts.get(c.escrowId)?.claimantIdentityKey === c.claimantIdentityKey
      console.log(`${accepted ? 'ACCEPTED' : 'pending '} ${c.satoshis} sats  ${c.escrowId}`)
      console.log(`         claimant ${c.claimantIdentityKey}`)
      console.log(`         pr ${untrusted(c.prUrl)}${c.note !== '' ? `  note ${untrusted(c.note)}` : ''}`)
    }
  })

program
  .command('accept <escrowId> <claimantIdentityKey>')
  .description('Accept a claim (sponsor): records the winner; release on merge (autorelease) or via `gitpaid release`')
  .action(async (escrowId: string, claimantIdentityKey: string) => {
    const { state, ownKey, mbx } = await loadSponsorState(makeWallet())
    const claim = state.claims.find(c => c.escrowId === escrowId && c.claimantIdentityKey === claimantIdentityKey)
    if (claim === undefined) {
      console.error(`no claim from ${claimantIdentityKey} on ${escrowId}`)
      process.exitCode = 1
      return
    }
    const accept: AcceptMsg = { type: 'accept', escrowId, claimantIdentityKey, prUrl: claim.prUrl, createdAt: Date.now() }
    const body = JSON.stringify(accept)
    await mbx.sendMessage({ recipient: ownKey, messageBox: GITPAID_BOX, body })
    await mbx.sendMessage({ recipient: claimantIdentityKey, messageBox: GITPAID_BOX, body }).catch(() => {})
    console.log(`accepted ${claimantIdentityKey} for ${escrowId} — release with \`gitpaid release ${escrowId}\` or run \`gitpaid autorelease\``)
  })

program
  .command('release <escrowId>')
  .description('Release a 1-of-1 bounty to its accepted claimant now (sponsor)')
  .action(async (escrowId: string) => {
    const { state } = await loadSponsorState(makeWallet())
    const invite = state.invites.get(escrowId)
    const accept = state.accepts.get(escrowId)
    if (invite === undefined) {
      console.error(`no bounty ${escrowId} found in your records`)
      process.exitCode = 1
      return
    }
    if (accept === undefined) {
      console.error(`no accepted claim on ${escrowId} — run \`gitpaid claims\` then \`gitpaid accept\``)
      process.exitCode = 1
      return
    }
    const { txid } = await releaseSoloBounty(invite, accept.claimantIdentityKey)
    console.log(`released — payout tx ${txid} to ${accept.claimantIdentityKey}`)
    console.log('overlay eviction: client-submitted spends evict immediately; the hourly sweep backstops the rest')
  })

program
  .command('autorelease')
  .description('Daemon: release accepted 1-of-1 bounties when their PR merges (PAT via GITPAID_GITHUB_TOKEN env, TR-010)')
  .option('--interval <seconds>', 'poll interval', '60')
  .option('--once', 'run a single tick and exit')
  .action(async (opts: { interval: string, once?: boolean }) => {
    const wallet = makeWallet()
    const ghToken = process.env.GITPAID_GITHUB_TOKEN
    const intervalMs = Math.max(30, Number(opts.interval)) * 1000

    const tick = async (): Promise<void> => {
      const { state } = await loadSponsorState(wallet)
      const pending = [...state.accepts.values()]
        .filter(a => state.invites.has(a.escrowId))
        .map(a => {
          const invite = state.invites.get(a.escrowId) as GitPaidInvite
          return {
            escrowId: a.escrowId,
            claimantIdentityKey: a.claimantIdentityKey,
            prUrl: a.prUrl,
            threshold: invite.threshold,
            controllers: invite.controllers.length,
          }
        })

      const results = await runAutoreleaseOnce({
        pending,
        ghToken,
        release: async (escrowId, claimant) => {
          const invite = state.invites.get(escrowId) as GitPaidInvite
          return await releaseSoloBounty(invite, claimant)
        },
      })
      for (const r of results) {
        if (r.outcome !== 'unmerged') {
          console.log(`[${new Date().toISOString()}] ${r.escrowId}: ${r.outcome}${r.detail !== undefined ? ` (${r.detail})` : ''}`)
        }
      }
    }

    if (opts.once === true) {
      await tick()
      return
    }
    console.log(`autorelease watching (every ${intervalMs / 1000}s, ^C to stop)${ghToken === undefined ? ' — no GITPAID_GITHUB_TOKEN set, public repos only' : ''}`)
    for (;;) {
      try {
        await tick()
      } catch (err) {
        console.error(`tick failed: ${err instanceof Error ? err.message : String(err)} — retrying`)
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
  })

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
