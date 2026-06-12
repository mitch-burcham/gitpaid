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
import { WalletClient, HTTPWalletJSON } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { GitPaidAgentClient, DEFAULT_WALLET_URL, type BountyInfo } from './core.js'
import { runMcpServer } from './mcp.js'

const OVERLAY_URL = process.env.GITPAID_OVERLAY_URL ?? 'http://localhost:8080'
const WALLET_URL = process.env.GITPAID_WALLET_URL ?? DEFAULT_WALLET_URL
const MESSAGEBOX_HOST = process.env.GITPAID_MESSAGEBOX_HOST ?? 'https://gmb.bsvblockchain.tech'
const WALLET_INSTALL_HINT =
  'bsv-wallet not found. Install it (Calhooon/bsv-wallet-cli):\n' +
  '  curl -sSf https://raw.githubusercontent.com/Calhooon/bsv-wallet-cli/main/install.sh | sh\n' +
  'or: cargo install --git https://github.com/Calhooon/bsv-wallet-cli.git'

function makeWallet (): WalletClient {
  return new WalletClient(new HTTPWalletJSON(undefined, WALLET_URL), 'gitpaid-agent')
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
    // 1. bsv-wallet binary (ADR-004)
    const version = spawnSync('bsv-wallet', ['--version'], { encoding: 'utf8' })
    if (version.error !== undefined) {
      console.error(WALLET_INSTALL_HINT)
      process.exitCode = 1
      return
    }
    console.log(`bsv-wallet ${version.stdout.trim()}`)

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

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
