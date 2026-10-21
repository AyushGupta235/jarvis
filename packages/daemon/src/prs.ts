import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { MERGED_WINDOW_DAYS, type PrState, type PullRequest } from '@jarvis/protocol';
import { logError } from './log';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { env, timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message).trim()));
      else res(stdout);
    });
  });
}

const FRAGMENT = `fragment pr on PullRequest {
  number title url isDraft state mergedAt headRefName baseRefName updatedAt additions deletions reviewDecision mergeable
  repository { nameWithOwner }
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const QUERY = `query {
  viewer { login pullRequests(first: 40, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pr } } }
  review: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 30) { nodes { ... on PullRequest { ...pr } } }
}
${FRAGMENT}`;

/** Your merged PRs. A separate, lighter request (no CI rollup): folded into QUERY, GitHub answers with 502s. */
function mergedQuery(): string {
  const since = new Date(Date.now() - MERGED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return `query {
  merged: search(query: "is:pr is:merged author:@me merged:>=${since} sort:updated-desc", type: ISSUE, first: 100) { nodes { ... on PullRequest {
    number title url isDraft state mergedAt headRefName baseRefName updatedAt additions deletions
    repository { nameWithOwner } comments { totalCount }
  } } }
}`;
}

/** Parses `gh auth status` for every github.com account (you may be logged in to several). */
export function parseAccounts(out: string): string[] {
  const accts: string[] = [];
  for (const m of out.matchAll(/Logged in to github\.com account (\S+)/g)) if (m[1]) accts.push(m[1]);
  return accts;
}

function toPr(n: any, account: string, role: PullRequest['role']): PullRequest {
  return {
    account, role, repo: n.repository?.nameWithOwner ?? '', number: n.number, title: n.title, url: n.url, isDraft: !!n.isDraft,
    headRef: n.headRefName, baseRef: n.baseRefName, updatedAt: n.updatedAt,
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    review: n.reviewDecision ?? null, mergeable: n.mergeable ?? null,
    additions: n.additions ?? 0, deletions: n.deletions ?? 0, comments: n.comments?.totalCount ?? 0,
    state: n.state ?? 'OPEN', mergedAt: n.mergedAt ?? null,
  };
}

/** The PR for a branch: open ones first (yours before review requests), else the most recently merged. */
export function pickBranchPr(prs: PullRequest[], repo: string | null, branch: string | null): PullRequest | null {
  if (!repo || !branch) return null;
  const hits = prs.filter((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.headRef === branch);
  const open = hits.filter((p) => p.state === 'OPEN');
  if (open.length) return open.find((p) => p.role === 'author') ?? open[0]!;
  return hits.filter((p) => p.state === 'MERGED').sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0] ?? null;
}

/** Open PRs you authored, PRs waiting on your review, and your recently merged PRs, across all gh accounts, refreshed every 2 minutes. */
export class PrTracker extends EventEmitter {
  state: PrState = { accounts: [], prs: [], updatedAt: null, error: null };
  /** Last good result per account, so one account's transient failure doesn't blank the list. */
  private byAccount = new Map<string, PullRequest[]>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly gh: string | null, private readonly env: NodeJS.ProcessEnv) {
    super();
  }

  start(): void {
    if (!this.gh) {
      this.state.error = 'gh CLI not found on PATH';
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 120_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<PrState> {
    if (!this.gh || this.busy) return this.state;
    this.busy = true;
    try {
      let status = '';
      try {
        status = await run(this.gh, ['auth', 'status', '-h', 'github.com'], this.env);
      } catch (e) {
        status = (e as Error).message; // gh exits non-zero if any account has a problem but still lists them
      }
      const accounts = parseAccounts(status);
      const prs: PullRequest[] = [];
      const errors: string[] = [];
      await Promise.all(accounts.map(async (acct) => {
        try {
          const token = (await run(this.gh!, ['auth', 'token', '-h', 'github.com', '--user', acct], this.env)).trim();
          const gql = async (q: string): Promise<any> => {
            const env = { ...this.env, GH_TOKEN: token };
            try {
              return JSON.parse(await run(this.gh!, ['api', 'graphql', '-f', `query=${q}`], env)).data;
            } catch (e) {
              // GitHub's GraphQL API returns sporadic 502s on heavier queries; one retry clears most of them.
              if (!/HTTP 5\d\d|timeout|ETIMEDOUT|ECONNRESET/i.test((e as Error).message)) throw e;
              await new Promise((r) => setTimeout(r, 1500));
              return JSON.parse(await run(this.gh!, ['api', 'graphql', '-f', `query=${q}`], env)).data;
            }
          };
          const [open, merged] = await Promise.allSettled([gql(QUERY), gql(mergedQuery())]);
          if (open.status === 'rejected') throw open.reason;
          const j = open.value;
          const mine: PullRequest[] = [];
          for (const n of j?.viewer?.pullRequests?.nodes ?? []) mine.push(toPr(n, acct, 'author'));
          for (const n of j?.review?.nodes ?? []) if (n?.number) mine.push(toPr(n, acct, 'reviewer'));
          if (merged.status === 'fulfilled') {
            for (const n of merged.value?.merged?.nodes ?? []) if (n?.number) mine.push(toPr(n, acct, 'author'));
          } else {
            // Keep the merged PRs from the last good refresh rather than dropping them.
            mine.push(...(this.byAccount.get(acct) ?? []).filter((p) => p.state === 'MERGED'));
            errors.push(`${acct} (merged): ${(merged.reason as Error).message.slice(0, 200)}`);
          }
          this.byAccount.set(acct, mine);
        } catch (e) {
          errors.push(`${acct}: ${(e as Error).message.slice(0, 200)}${this.byAccount.has(acct) ? ' (showing last good list)' : ''}`);
        }
        prs.push(...(this.byAccount.get(acct) ?? []));
      }));
      prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.state = { accounts, prs, updatedAt: Date.now(), error: errors.length ? errors.join('; ') : null };
      if (errors.length) logError('PR refresh:', this.state.error);
      this.emit('changed');
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  forBranch(repo: string | null, branch: string | null): PullRequest | null {
    return pickBranchPr(this.state.prs, repo, branch);
  }
}

/** owner/name for a repo's origin remote on github.com, cached. */
export class RemoteCache {
  private cache = new Map<string, { at: number; value: string | null }>();

  get(root: string): string | null {
    const hit = this.cache.get(root);
    if (hit && Date.now() - hit.at < 300_000) return hit.value;
    if (!hit) this.cache.set(root, { at: Date.now(), value: null });
    execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 4000 }, (err, stdout) => {
      const m = err ? null : /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(stdout.trim());
      this.cache.set(root, { at: Date.now(), value: m?.[1] ?? null });
    });
    return hit?.value ?? null;
  }
}
