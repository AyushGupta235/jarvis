import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ActivityEntry, RpcRequest, RpcResponse, ServerEvent, Snapshot } from '@jarvis/protocol';
import type { JarvisService } from './service';
import { listDevServers } from './previews';
import type { Observers } from './observers';
import { log, logError } from './log';

type Handler = (params: any) => unknown | Promise<unknown>;

export function buildHandlers(svc: JarvisService, shutdown: () => void): Record<string, Handler> {
  return {
    'daemon.info': () => svc.info(),
    'daemon.shutdown': () => { setTimeout(shutdown, 50); return { ok: true }; },
    'snapshot': () => svc.snapshot(),
    'sessions.create': (p) => svc.create(p),
    'sessions.kill': async (p) => { await svc.kill(p.id); return { ok: true }; },
    'sessions.remove': async (p) => { await svc.remove(p.id); return { ok: true }; },
    'sessions.revive': (p) => svc.revive(p.id),
    'sessions.rename': (p) => { svc.rename(p.id, p.name); return { ok: true }; },
    'sessions.setHidden': (p) => { svc.setHidden(p.id, p.hidden); return { ok: true }; },
    'sessions.move': (p) => { svc.move(p.id, p.delta); return { ok: true }; },
    'sessions.attachSpec': (p) => svc.attachSpec(p.id),
    'sessions.sendKeys': async (p) => { await svc.sendKeys(p.id, p.text, p.enter); return { ok: true }; },
    'sessions.capture': async (p) => ({ text: await svc.capture(p.id, p.lines) }),
    'tmux.split': async (p) => { await svc.split(p.id, p.direction); return { ok: true }; },
    'tmux.selectPane': async (p) => { await svc.selectPane(p.id, p.direction); return { ok: true }; },
    'tmux.zoom': async (p) => { await svc.zoom(p.id); return { ok: true }; },
    'tmux.clearHistory': async (p) => { await svc.clearHistory(p.id); return { ok: true }; },
    'tmux.search': async (p) => { await svc.search(p.id); return { ok: true }; },
    'tmux.copyMode': async (p) => { await svc.copyMode(p.id); return { ok: true }; },
    'tmux.mouseState': (p) => svc.mouseState(p.id),
    'repos.list': () => svc.repos(),
    'agents.list': (p) => svc.agentsList(!!p?.refresh),
    'sessions.paste': async (p) => { await svc.paste(p.id, p.text); return { ok: true }; },
    'tmux.lastBuffer': (p) => svc.lastBuffer(p.id),
    'rich.history': (p) => svc.richHistory(p.id),
    'rich.send': (p) => { svc.richSend(p.id, String(p.text ?? '')); return { ok: true }; },
    'rich.interrupt': (p) => { svc.richInterrupt(p.id); return { ok: true }; },
    'rich.shell': (p) => svc.richShell(p.id, String(p.command ?? '')),
    'rich.shellStop': (p) => svc.richShellStop(p.id, String(p.shellId ?? '')),
    'rich.btw': (p) => svc.richBtw(p.id, String(p.question ?? '')),
    'rich.mcp': (p) => svc.richMcp(p.id, p.action, p.name, p.enabled),
    'rich.agents': (p) => svc.richAgents(p.id),
    'rich.stopTask': (p) => svc.richStopTask(p.id, p.taskId),
    'rich.addDir': (p) => svc.richAddDir(p.id, String(p.path ?? '')),
    'rich.branch': (p) => svc.richBranch(p.id, p.name),
    'rich.fork': (p) => svc.richFork(p.id, p.prompt),
    'rich.cd': (p) => svc.richCd(p.id, String(p.path ?? '')),
    'rich.hooks': (p) => svc.richHooks(p.id),
    'rich.agentSteps': (p) => svc.richAgentSteps(p.id, String(p.agentId ?? ''), String(p.toolUseId ?? '')),
    'rich.queue': (p) => svc.richQueue(p.id, p.uuid, p.action, p.text),
    'rich.respond': (p) => { svc.richRespond(p.id, p.requestId, p.behavior === 'allow' ? 'allow' : 'deny', p.message); return { ok: true }; },
    'rich.answer': (p) => { svc.richAnswer(p.id, p.requestId, p.answers ?? {}); return { ok: true }; },
    'rich.context': (p) => svc.richContext(p.id),
    'rich.restart': (p) => svc.richRestart(p.id),
    'rich.rewindPoints': (p) => svc.richRewindPoints(p.id),
    'rich.rewind': (p) => svc.richRewind(p.id, String(p.upToMessageId ?? '')),
    'rich.info': (p) => svc.richInfo(p.id),
    'rich.background': (p) => svc.richBackground(p.id),
    'rich.conversations': (p) => svc.richConversations(p.id),
    'rich.resume': (p) => svc.richResume(p.id, String(p.agentSessionId ?? '')),
    'rich.setPermissionMode': async (p) => { await svc.richSetPermissionMode(p.id, p.mode); return { ok: true }; },
    'rich.export': (p) => svc.richExport(p.id),
    'preview.servers': (p) => listDevServers(p?.root ?? null),
    'thinking.list': (p) => svc.thinking(p.id),
    'sessions.switchMode': (p) => svc.switchMode(p.id, p.mode === 'rich' ? 'rich' : 'terminal', p.command ?? null),
    'activity.list': (p) => svc.activity(p.id, p.limit),
    'files.list': (p) => svc.filesList(p.root),
    'files.read': (p) => svc.filesRead(p.path),
    'files.changes': (p) => svc.filesChanges(p.root),
    'files.diff': async (p) => ({ diff: await svc.filesDiff(p.root, p.path) }),
    'files.watch': (p) => { svc.filesWatch(p.root); return { ok: true }; },
    'files.touched': (p) => svc.touched(p.id),
    'docs.list': (p) => svc.docs(p.id),
    'prs.refresh': () => svc.refreshPrs(),
    'connectors.list': (p) => svc.connectors(p.id),
    'connectors.check': async (p) => ({ output: await svc.checkConnectors(p.id) }),
    'usage.summary': (p) => svc.usageSummary(p?.days),
    'open.editor': (p) => { svc.openEditor(p.path, p.line); return { ok: true }; },
  };
}

async function dispatch(handlers: Record<string, Handler>, req: RpcRequest): Promise<RpcResponse> {
  const h = handlers[req.method];
  if (!h) return { id: req.id, error: { message: `unknown method ${req.method}` } };
  try {
    return { id: req.id, result: await h(req.params ?? {}) };
  } catch (e) {
    return { id: req.id, error: { message: (e as Error).message } };
  }
}

/** True if something is already listening on the socket. */
export function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const s = connect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export async function serve(socketPath: string, svc: JarvisService, handlers: Record<string, Handler>, observers: Observers) {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const clients = new Set<WebSocket>();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    // Agent observers: Claude hook events and status line JSON, posted by ~/.jarvis/bin shims.
    if (req.method === 'POST' && req.url?.startsWith('/ingest/')) {
      const url = new URL(req.url, 'http://jarvis');
      const sid = url.searchParams.get('s');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(204).end();
        if (!sid) return;
        try {
          const j = JSON.parse(body || '{}');
          if (url.pathname === '/ingest/claude-hook') observers.claudeHook(sid, j);
          else if (url.pathname === '/ingest/claude-status') observers.claudeStatus(sid, j);
        } catch (e) {
          logError('ingest failed', (e as Error).message);
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let parsed: RpcRequest;
        try {
          parsed = { id: 0, ...JSON.parse(body || '{}') };
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        const out = await dispatch(handlers, parsed);
        res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    const hello: ServerEvent = { event: 'snapshot', data: svc.snapshot() };
    ws.send(JSON.stringify(hello));
    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(String(raw));
      } catch {
        return;
      }
      ws.send(JSON.stringify(await dispatch(handlers, req)));
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (e) => logError('ws client error', e));
  });

  const broadcast = (ev: ServerEvent) => {
    const msg = JSON.stringify(ev);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  svc.on('snapshot', (snap: Snapshot) => broadcast({ event: 'snapshot', data: snap }));
  svc.on('activity', (e: ActivityEntry) => broadcast({ event: 'activity', data: e }));
  svc.on('files.changed', (d: { root: string; paths: string[] }) => broadcast({ event: 'files.changed', data: d }));
  svc.on('attention', (d) => broadcast({ event: 'attention', data: d }));
  svc.on('rich.event', (d) => broadcast({ event: 'rich.event', data: d }));

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.close();
        wss.close();
        http.close(() => resolve());
        try { unlinkSync(socketPath); } catch { /* gone */ }
      }),
  };
}
