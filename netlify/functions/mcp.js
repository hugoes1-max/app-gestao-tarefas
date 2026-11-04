// Conector MCP (servidor remoto) para o Claude acessar as tarefas do app.
// Endpoint: POST /mcp?key=<MCP_TOKEN>   (ou header Authorization: Bearer <MCP_TOKEN>)
//
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   MCP_TOKEN                 token secreto longo, exclusivo do conector (você inventa)
//   FIREBASE_SERVICE_ACCOUNT  mesma variável usada pela add-task
//   OWNER_UID, OWNER_EMAIL    mesmas variáveis usadas pela add-task
//
// Ferramentas: listar_tarefas, criar_tarefas, atualizar_tarefa, concluir_tarefa.
// Não há ferramenta de exclusão de propósito.

const crypto = require('crypto');
const { buildTask, toValue } = require('./add-task.js');

const SERVER_INFO = { name: 'app-gestao-tarefas', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(sa.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Falha ao obter token Google.');
  return data.access_token;
}

// Formato de valor do Firestore REST -> JS
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = fromValue(val);
    return o;
  }
  return null;
}

const decodeDoc = (doc) => {
  const o = {};
  for (const [k, v] of Object.entries(doc.fields || {})) o[k] = fromValue(v);
  return o;
};

function ctx() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
  const owner = { uid: process.env.OWNER_UID, email: process.env.OWNER_EMAIL };
  if (!owner.uid || !owner.email) throw new Error('OWNER_UID/OWNER_EMAIL ausentes.');
  const root = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  return { sa, owner, root };
}

async function fetchOwnTasks(c, token) {
  const res = await fetch(`${c.root}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'tasks' }],
        where: {
          fieldFilter: { field: { fieldPath: 'ownerId' }, op: 'EQUAL', value: { stringValue: c.owner.uid } },
        },
      },
    }),
  });
  if (!res.ok) throw new Error('Falha ao ler o Firestore: ' + (await res.text()));
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => decodeDoc(r.document));
}

async function fetchOwnTask(c, token, id) {
  if (!/^task_[A-Za-z0-9_]+$/.test(String(id))) throw new Error('id inválido.');
  const res = await fetch(`${c.root}/tasks/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new Error('Tarefa não encontrada.');
  if (!res.ok) throw new Error('Falha ao ler o Firestore: ' + (await res.text()));
  const task = decodeDoc(await res.json());
  if (task.ownerId !== c.owner.uid) throw new Error('Tarefa não encontrada.');
  return task;
}

// Grava só os campos do objeto (updateMask), preservando campos desconhecidos do app.
async function writeTask(c, token, task) {
  const fields = {};
  for (const [k, v] of Object.entries(task)) fields[k] = toValue(v);
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${c.root}/tasks/${task.id}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error('Falha ao gravar no Firestore: ' + (await res.text()));
}

const summary = (t) => ({
  id: t.id,
  name: t.name,
  prio: t.prio,
  cat: t.cat || '',
  resp: t.resp || '',
  date: t.date || '',
  time: t.time || '',
  durVal: t.durVal || '',
  durUnit: t.durUnit || 'min',
  done: !!t.done,
  recurrence: t.recurrence || null,
  completedOccurrences: t.completedOccurrences || [],
});

// Aplica alterações validando com as mesmas regras da add-task.
function applyChanges(existing, changes, owner) {
  const merged = { ...summary(existing), ...changes };
  const built = buildTask(merged, owner);
  built.id = existing.id;
  built.createdAt = existing.createdAt || built.createdAt;
  built.shared = existing.shared === undefined ? false : existing.shared;
  built.sharedWith = existing.sharedWith || [];
  built.doneAt = !!existing.done === built.done ? existing.doneAt || null : built.doneAt;
  return built;
}

const TASK_PROPS = {
  name: { type: 'string', description: 'Nome da tarefa' },
  prio: { type: 'string', enum: ['urgente', 'importante', 'circunstancial', 'delegar'], description: 'Prioridade (padrão: circunstancial)' },
  cat: { type: 'string', description: 'Categoria' },
  resp: { type: 'string', description: 'Responsável' },
  date: { type: 'string', description: 'Data AAAA-MM-DD' },
  time: { type: 'string', description: 'Hora HH:MM' },
  durVal: { type: 'string', description: 'Duração (número)' },
  durUnit: { type: 'string', enum: ['min', 'h', 'd'] },
  recurrence: {
    type: 'object',
    description: 'Recorrência; exige date de início',
    properties: {
      type: { type: 'string', enum: ['diaria', 'semanal', 'mensal', 'dias_semana'] },
      days: { type: 'array', items: { type: 'number' }, description: 'Para dias_semana (0=domingo)' },
      until: { type: 'string', description: 'AAAA-MM-DD' },
      count: { type: 'number' },
    },
    required: ['type'],
  },
};

const TOOLS = [
  {
    name: 'listar_tarefas',
    description: 'Lista as tarefas do app, com filtros opcionais. Retorna no máximo 200.',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'boolean', description: 'true = só concluídas, false = só pendentes' },
        date: { type: 'string', description: 'Só tarefas com esta data (AAAA-MM-DD)' },
        de: { type: 'string', description: 'Data inicial do intervalo (AAAA-MM-DD)' },
        ate: { type: 'string', description: 'Data final do intervalo (AAAA-MM-DD)' },
        prio: { type: 'string', enum: ['urgente', 'importante', 'circunstancial', 'delegar'] },
        cat: { type: 'string' },
        busca: { type: 'string', description: 'Texto contido no nome' },
      },
    },
  },
  {
    name: 'criar_tarefas',
    description: 'Cria uma ou mais tarefas (máximo 50).',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', maxItems: 50, items: { type: 'object', properties: TASK_PROPS, required: ['name'] } },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'atualizar_tarefa',
    description: 'Altera campos de uma tarefa existente. Envie só o que muda.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...TASK_PROPS },
      required: ['id'],
    },
  },
  {
    name: 'concluir_tarefa',
    description:
      'Marca uma tarefa como concluída (ou reabre com done=false). Em tarefa recorrente, informe occurrence (AAAA-MM-DD) para concluir só aquela ocorrência.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        done: { type: 'boolean', description: 'padrão true' },
        occurrence: { type: 'string', description: 'Data da ocorrência (tarefas recorrentes)' },
      },
      required: ['id'],
    },
  },
];

async function callTool(name, args) {
  const c = ctx();
  const token = await getAccessToken(c.sa);

  if (name === 'listar_tarefas') {
    let list = await fetchOwnTasks(c, token);
    if (typeof args.done === 'boolean') list = list.filter((t) => !!t.done === args.done);
    if (args.date) list = list.filter((t) => t.date === args.date);
    if (args.de) list = list.filter((t) => t.date && t.date >= args.de);
    if (args.ate) list = list.filter((t) => t.date && t.date <= args.ate);
    if (args.prio) list = list.filter((t) => t.prio === args.prio);
    if (args.cat) list = list.filter((t) => (t.cat || '').toLowerCase() === String(args.cat).toLowerCase());
    if (args.busca) list = list.filter((t) => (t.name || '').toLowerCase().includes(String(args.busca).toLowerCase()));
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));
    return { total: list.length, tasks: list.slice(0, 200).map(summary) };
  }

  if (name === 'criar_tarefas') {
    const list = Array.isArray(args.tasks) ? args.tasks : [];
    if (!list.length) throw new Error('Envie "tasks" com ao menos uma tarefa.');
    if (list.length > 50) throw new Error('Máximo de 50 tarefas por chamada.');
    const built = list.map((t) => buildTask(t, c.owner));
    for (const t of built) await writeTask(c, token, t);
    return { ok: true, created: built.map((t) => ({ id: t.id, name: t.name })) };
  }

  if (name === 'atualizar_tarefa') {
    const { id, ...changes } = args;
    const existing = await fetchOwnTask(c, token, id);
    const built = applyChanges(existing, changes, c.owner);
    await writeTask(c, token, built);
    return { ok: true, task: summary(built) };
  }

  if (name === 'concluir_tarefa') {
    const done = args.done === undefined ? true : !!args.done;
    const existing = await fetchOwnTask(c, token, args.id);
    const changes = {};
    if (args.occurrence) {
      if (!existing.recurrence) throw new Error('A tarefa não é recorrente; omita "occurrence".');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.occurrence)) throw new Error('occurrence deve ser AAAA-MM-DD.');
      const set = new Set(existing.completedOccurrences || []);
      if (done) set.add(args.occurrence);
      else set.delete(args.occurrence);
      changes.completedOccurrences = [...set];
    } else {
      changes.done = done;
    }
    const built = applyChanges(existing, changes, c.owner);
    await writeTask(c, token, built);
    return { ok: true, task: summary(built) };
  }

  throw new Error('Ferramenta desconhecida: ' + name);
}

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notificação
  if (method === 'initialize') {
    return rpc(id, {
      protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params && params.name, (params && params.arguments) || {});
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) {
      return rpc(id, { isError: true, content: [{ type: 'text', text: e.message }] });
    }
  }
  return rpcErr(id, -32601, 'Método não suportado: ' + method);
}

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: body === undefined ? '' : JSON.stringify(body),
});

function authorized(event) {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return false;
  const h = event.headers || {};
  const bearer = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  const given = bearer || (event.queryStringParameters && event.queryStringParameters.key) || '';
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

exports.handler = async (event) => {
  if (!authorized(event)) return reply(401, { error: 'Não autorizado.' });
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '');
  } catch (e) {
    return reply(400, rpcErr(null, -32700, 'JSON inválido.'));
  }

  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map(handleMessage))).filter(Boolean);
    return out.length ? reply(200, out) : reply(202);
  }
  const out = await handleMessage(payload);
  return out ? reply(200, out) : reply(202);
};
