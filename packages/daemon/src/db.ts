import { DatabaseSync } from 'node:sqlite';
import type { AgentKind, SessionStatus } from '@jarvis/protocol';

export interface SessionRow {
  id: string;
  tmux_name: string;
  name: string;
  agent: AgentKind;
  model: string | null;
  agent_session_id: string | null;
  cwd: string;
  repo_root: string;
  worktree: string | null;
  hidden: number;
  status: SessionStatus;
  created_at: number;
  exited_at: number | null;
  sort_order: number;
}

const SCHEMA = `
create table if not exists sessions (
  id text primary key,
  tmux_name text not null unique,
  name text not null,
  agent text not null,
  model text,
  agent_session_id text,
  cwd text not null,
  repo_root text not null,
  worktree text,
  hidden integer not null default 0,
  status text not null,
  created_at integer not null,
  exited_at integer,
  sort_order integer not null default 0
);
create table if not exists kv (
  key text primary key,
  value text not null
);
create table if not exists events (
  id integer primary key autoincrement,
  session_id text not null,
  ts integer not null,
  kind text not null,
  tool_use_id text,
  tool text,
  agent_id text,
  agent_type text,
  status text,
  duration_ms integer,
  summary text not null,
  input text,
  output text
);
create index if not exists events_session on events (session_id, id);
create unique index if not exists events_tool on events (session_id, tool_use_id) where tool_use_id is not null;
create table if not exists usage_msgs (
  key text primary key,
  ts integer not null,
  day text not null,
  agent text not null,
  model text not null,
  project text not null,
  input integer not null,
  output integer not null,
  cache_read integer not null,
  cache_write integer not null
);
create index if not exists usage_day on usage_msgs (day);
create table if not exists tool_day (
  day text not null,
  tool text not null,
  calls integer not null,
  primary key (day, tool)
);
create table if not exists lines_day (
  day text primary key,
  added integer not null,
  removed integer not null
);
create table if not exists usage_files (
  path text primary key,
  offset integer not null,
  size integer not null,
  meta text
);
create table if not exists tool_seen (
  server text not null,
  day text not null,
  calls integer not null,
  last_used integer not null,
  sample text,
  primary key (server, day)
);
`;

export class Db {
  /** Shared connection for modules that own their own tables (activity, usage). */
  readonly raw: DatabaseSync;
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.raw = this.db;
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 2000; pragma synchronous = normal;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created by earlier versions. */
  private migrate(): void {
    const cols = (t: string) => new Set((this.db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    const sessions = cols('sessions');
    if (sessions.has('claude_session_id') && !sessions.has('agent_session_id')) {
      this.db.exec('alter table sessions rename column claude_session_id to agent_session_id');
    }
    if (!cols('tool_seen').has('sample')) this.db.exec('alter table tool_seen add column sample text');
    if (!cols('usage_msgs').has('session')) {
      // New per-message fields: rebuild the usage index from scratch (it takes seconds).
      this.db.exec(`alter table usage_msgs add column session text;
        delete from usage_msgs; delete from usage_files; delete from tool_seen; delete from tool_day; delete from lines_day;`);
    }
  }

  allSessions(): SessionRow[] {
    return this.db.prepare('select * from sessions order by sort_order, created_at').all() as unknown as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('select * from sessions where id = ?').get(id) as unknown as SessionRow | undefined;
  }

  insertSession(r: SessionRow): void {
    this.db
      .prepare(
        `insert into sessions (id, tmux_name, name, agent, model, agent_session_id, cwd, repo_root, worktree,
          hidden, status, created_at, exited_at, sort_order)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.tmux_name, r.name, r.agent, r.model, r.agent_session_id, r.cwd, r.repo_root, r.worktree,
        r.hidden, r.status, r.created_at, r.exited_at, r.sort_order);
  }

  updateSession(id: string, patch: Partial<SessionRow>): void {
    const keys = Object.keys(patch) as (keyof SessionRow)[];
    if (!keys.length) return;
    const sql = `update sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => patch[k] as never), id);
  }

  deleteSession(id: string): void {
    this.db.prepare('delete from sessions where id = ?').run(id);
  }

  nextOrder(): number {
    const r = this.db.prepare('select coalesce(max(sort_order), 0) + 1 as n from sessions').get() as { n: number };
    return r.n;
  }

  lastUsedByCwd(): Map<string, number> {
    const rows = this.db.prepare('select cwd, max(created_at) as t from sessions group by cwd').all() as unknown as {
      cwd: string;
      t: number;
    }[];
    return new Map(rows.map((r) => [r.cwd, r.t]));
  }

  kvGet(key: string): unknown {
    const r = this.db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : null;
  }

  kvSet(key: string, value: unknown): void {
    this.db
      .prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }
}
