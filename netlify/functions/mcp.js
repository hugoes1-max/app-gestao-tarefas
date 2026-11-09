// Servidor MCP remoto (Streamable HTTP, sem estado) para o Claude acessar as tarefas do app.
// Endpoint: POST /mcp   (header: Authorization: Bearer <TASKS_API_TOKEN>)
//
// Usa as mesmas variáveis de ambiente do /api/add-task:
//   TASKS_API_TOKEN, FIREBASE_SERVICE_ACCOUNT, OWNER_UID, OWNER_EMAIL
//
// Ferramentas: listar_tarefas, adicionar_tarefas, atualizar_tarefa, concluir_tarefa.
// (Não há ferramenta de exclusão, de propósito.)

const crypto = require('crypto');
const { buildTask, toValue } = require('./add-task');

const PRIOS = ['urgente', 'importante', 'circunstancial', 'delegar'];
const RECUR = ['diaria', 'semanal', 'mensal', 'dias_semana'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

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
  if (!res.ok || !data.access_token) throw new Error('Falha ao obter token Google: ' + JSON.stringify(data));
  return data.access_token;
}

function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromValue(x);
    return o;
  }
  return null;
}

const docToTask = (doc) => {
  const t = {};
  for (const [k, v] of Object.entries(doc.fields || {})) t[k] = fromValue(v);
  return t;
};

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// ---------- contexto Firestore ----------
function context() {
  let sa;
  try {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT ausente ou inválida.');
  }
  const owner = { uid: process.env.OWNER_UID, email: process.env.OWNER_EMAIL };
  if (!owner.uid || !owner.email) throw new Error('OWNER_UID/OWNER_EMAIL ausentes.');
  const root = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  return { sa, owner, root };
}

async function fetchOwnTasks(ctx, token) {
  const res = await fetch(`${ctx.root}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'tasks' }],
        where: {
          fieldFilter: { field: { fieldPath: 'ownerId' }, op: 'EQUAL', value: { stringValue: ctx.owner.uid } },
        },
        limit: 1000,
      },
    }),
  });
  if (!res.ok) throw new Error('Falha ao ler o Firestore: ' + (await res.text()));
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => docToTask(r.document));
}

async function fetchOwnTask(ctx, token, id) {
  const safe = str(id);
  if (!/^[\w-]+$/.test(safe)) throw new Error('id inválido.');
  const res = await fetch(`${ctx.root}/tasks/${safe}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new Error('Tarefa não encontrada.');
  if (!res.ok) throw new Error('Falha ao ler a tarefa: ' + (await res.text()));
  const task = docToTask(await res.json());
  if (task.ownerId !== ctx.owner.uid) throw new Error('Tarefa não encontrada.');
  return task;
}

async function patchTask(ctx, token, id, changes) {
  const keys = Object.keys(changes);
  const fields = {};
  for (const k of keys) fields[k] = toValue(changes[k]);
  const mask = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${ctx.root}/tasks/${id}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error('Falha ao gravar no Firestore: ' + (await res.text()));
}

// ---------- ferramentas ----------
const recurrenceSchema = {
  type: 'object',
  description: 'Recorrência opcional. Exige "date" de início.',
  properties: {
    type: { type: 'string', enum: RECUR },
    days: { type: 'array', items: { type: 'integer' }, description: 'Para dias_semana: 0=domingo ... 6=sábado' },
    until: { type: 'string', description: 'AAAA-MM-DD' },
    count: { type: 'integer', description: 'Número de ocorrências (máx. 366)' },
  },
  required: ['type'],
};

const taskProps = {
  name: { type: 'string', description: 'Nome da tarefa' },
  prio: { type: 'string', enum: PRIOS, description: 'Prioridade (padrão: circunstancial)' },
  cat: { type: 'string', description: 'Categoria (ex.: Casa)' },
  resp: { type: 'string', description: 'Responsável' },
  date: { type: 'string', description: 'AAAA-MM-DD' },
  time: { type: 'string', description: 'HH:MM' },
  durVal: { type: 'string', description: 'Duração (valor)' },
  durUnit: { type: 'string', enum: ['min', 'h', 'd'] },
  recurrence: recurrenceSchema,
};

const TOOLS = [
  {
    name: 'listar_tarefas',
    description:
      'Lista as tarefas e compromissos do app. Filtros opcionais. Tarefas recorrentes aparecem uma vez, com a data de início e a regra de recorrência.',
    inputSchema: {
      type: 'object',
      properties: {
        concluida: { type: 'boolean', description: 'true = só concluídas; false = só pendentes' },
        prio: { type: 'string', enum: PRIOS },
        cat: { type: 'string' },
        de: { type: 'string', description: 'Data inicial AAAA-MM-DD (inclusive)' },
        ate: { type: 'string', description: 'Data final AAAA-MM-DD (inclusive)' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'adicionar_tarefas',
    description: 'Cadastra uma ou mais tarefas (máx. 50) no app.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'object', properties: taskProps, required: ['name'] } },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'atualizar_tarefa',
    description: 'Altera campos de uma tarefa existente. Envie só os campos que mudam. Use recurrence: null para remover a recorrência.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id da tarefa (de listar_tarefas)' }, ...taskProps },
      required: ['id'],
    },
    annotations: { idempotentHint: true },
  },
  {
    name: 'concluir_tarefa',
    description:
      'Marca uma tarefa como concluída (ou reabre com concluida=false). Para tarefa recorrente, informe a data da ocorrência (AAAA-MM-DD) que foi concluída.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        concluida: { type: 'boolean', description: 'Padrão: true' },
        ocorrencia: { type: 'string', description: 'AAAA-MM-DD; obrigatório para tarefa recorrente' },
      },
      required: ['id'],
    },
    annotations: { idempotentHint: true },
  },
];

const summarize = (t) => ({
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

const checkDate = (d, label) => {
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`${label} deve ser AAAA-MM-DD.`);
};

async function callTool(name, args) {
  const ctx = context();
  const token = await getAccessToken(ctx.sa);
  args = args || {};

  if (name === 'listar_tarefas') {
    let list = await fetchOwnTasks(ctx, token);
    if (typeof args.concluida === 'boolean') list = list.filter((t) => !!t.done === args.concluida);
    if (args.prio) list = list.filter((t) => t.prio === args.prio);
    if (args.cat) list = list.filter((t) => (t.cat || '').toLowerCase() === str(args.cat).toLowerCase());
    if (args.de) list = list.filter((t) => t.date && t.date >= args.de);
    if (args.ate) list = list.filter((t) => t.date && t.date <= args.ate);
    list.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));
    return { total: list.length, tarefas: list.map(summarize) };
  }

  if (name === 'adicionar_tarefas') {
    const input = Array.isArray(args.tasks) ? args.tasks : [];
    if (!input.length) throw new Error('Envie ao menos uma tarefa em "tasks".');
    if (input.length > 50) throw new Error('Máximo de 50 tarefas por chamada.');
    const tasks = input.map((t) => buildTask(t, ctx.owner));
    const created = [];
    for (const t of tasks) {
      const fields = {};
      for (const [k, v] of Object.entries(t)) fields[k] = toValue(v);
      const res = await fetch(`${ctx.root}/tasks/${t.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error('Falha ao gravar no Firestore: ' + (await res.text()) + ' | já criadas: ' + JSON.stringify(created));
      created.push({ id: t.id, name: t.name });
    }
    return { ok: true, created };
  }

  if (name === 'atualizar_tarefa') {
    const task = await fetchOwnTask(ctx, token, args.id);
    const changes = {};
    if (args.name !== undefined) {
      if (!str(args.name)) throw new Error('name não pode ser vazio.');
      changes.name = str(args.name);
    }
    if (args.prio !== undefined) {
      const p = str(args.prio).toLowerCase();
      if (!PRIOS.includes(p)) throw new Error(`prio inválida (use ${PRIOS.join(', ')})`);
      changes.prio = p;
    }
    for (const k of ['cat', 'resp', 'durVal']) if (args[k] !== undefined) changes[k] = str(args[k]);
    if (args.date !== undefined) {
      checkDate(str(args.date), 'date');
      changes.date = str(args.date);
    }
    if (args.time !== undefined) {
      if (str(args.time) && !/^\d{2}:\d{2}$/.test(str(args.time))) throw new Error('time deve ser HH:MM.');
      changes.time = str(args.time);
    }
    if (args.durUnit !== undefined) {
      if (!['min', 'h', 'd'].includes(args.durUnit)) throw new Error('durUnit deve ser min, h ou d.');
      changes.durUnit = args.durUnit;
    }
    if (args.recurrence !== undefined) {
      const r = args.recurrence;
      if (r === null) changes.recurrence = null;
      else {
        if (!RECUR.includes(r.type)) throw new Error(`recurrence.type inválido: ${r.type}`);
        const rec = { type: r.type };
        if (r.type === 'dias_semana') rec.days = Array.isArray(r.days) ? r.days.map(Number) : [];
        if (r.until) rec.until = str(r.until);
        if (Number(r.count) > 0) rec.count = Math.min(Math.floor(Number(r.count)), 366);
        changes.recurrence = rec;
      }
    }
    const finalDate = changes.date !== undefined ? changes.date : task.date;
    const finalRec = changes.recurrence !== undefined ? changes.recurrence : task.recurrence;
    if (finalRec && !finalDate) throw new Error('Tarefa recorrente precisa de "date" de início.');
    if (!Object.keys(changes).length) throw new Error('Nenhum campo para atualizar.');
    await patchTask(ctx, token, task.id, changes);
    return { ok: true, id: task.id, atualizados: Object.keys(changes) };
  }

  if (name === 'concluir_tarefa') {
    const task = await fetchOwnTask(ctx, token, args.id);
    const done = args.concluida !== false;
    if (task.recurrence) {
      const occ = str(args.ocorrencia);
      if (!occ) throw new Error('Tarefa recorrente: informe "ocorrencia" (AAAA-MM-DD).');
      checkDate(occ, 'ocorrencia');
      const set = new Set((task.completedOccurrences || []).map(String));
      if (done) set.add(occ);
      else set.delete(occ);
      await patchTask(ctx, token, task.id, { completedOccurrences: [...set].sort() });
      return { ok: true, id: task.id, ocorrencia: occ, concluida: done };
    }
    await patchTask(ctx, token, task.id, { done, doneAt: done ? new Date().toISOString() : null });
    return { ok: true, id: task.id, concluida: done };
  }

  throw new Error('Ferramenta desconhecida: ' + name);
}

// ---------- protocolo MCP (JSON-RPC) ----------
async function handleMessage(msg) {
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  if (!msg || typeof msg !== 'object' || !msg.method) {
    return hasId ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Requisição inválida.' } } : null;
  }
  if (!hasId) return null; // notificações (ex.: notifications/initialized)

  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'app-gestao-tarefas', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const p = msg.params || {};
      if (!TOOLS.some((t) => t.name === p.name)) return fail(-32602, 'Ferramenta desconhecida: ' + p.name);
      try {
        const out = await callTool(p.name, p.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: 'Erro: ' + e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, 'Método não suportado: ' + msg.method);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: '' };
  }

  const expected = process.env.TASKS_API_TOKEN;
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const given = auth.replace(/^Bearer\s+/i, '');
  const ok =
    expected &&
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
      body: JSON.stringify({ error: 'Token inválido.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '');
  } catch (e) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido.' } });
  }

  const batch = Array.isArray(body);
  const responses = [];
  for (const m of batch ? body : [body]) {
    const r = await handleMessage(m);
    if (r) responses.push(r);
  }
  if (!responses.length) return { statusCode: 202, body: '' };
  return json(200, batch ? responses : responses[0]);
};
