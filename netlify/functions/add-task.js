// API para cadastrar tarefas no app sem abrir o app.
// POST /api/add-task   (header: Authorization: Bearer <TASKS_API_TOKEN>)
// Corpo: { "tasks": [ { "name": "...", "prio": "importante", "cat": "Casa", "date": "2026-10-11",
//          "recurrence": { "type": "diaria" } } ] }   (ou um único objeto de tarefa)
//
// Variáveis de ambiente (Netlify > Site configuration > Environment variables):
//   TASKS_API_TOKEN          token secreto longo (você inventa)
//   FIREBASE_SERVICE_ACCOUNT JSON da chave de serviço do Firebase (conteúdo inteiro)
//   OWNER_UID                seu UID no Firebase Auth (as tarefas ficam vinculadas a ele)
//   OWNER_EMAIL              seu e-mail (usado em ownerEmail)
//
// Sem dependências externas: assina o JWT com o módulo crypto do Node.

const crypto = require('crypto');

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

// JS -> formato de valor do Firestore REST
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function buildTask(input, owner) {
  const name = str(input.name || input.nome);
  if (!name) throw new Error('Tarefa sem "name".');
  const prio = str(input.prio || input.prioridade).toLowerCase() || 'circunstancial';
  if (!PRIOS.includes(prio)) throw new Error(`prio inválida: ${prio} (use ${PRIOS.join(', ')})`);
  const date = str(input.date || input.data);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date deve ser AAAA-MM-DD.');
  const time = str(input.time || input.hora);
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new Error('time deve ser HH:MM.');
  const durUnit = str(input.durUnit) || 'min';
  if (!['min', 'h', 'd'].includes(durUnit)) throw new Error('durUnit deve ser min, h ou d.');

  let recurrence = null;
  const r = input.recurrence || input.recorrencia;
  if (r && r.type) {
    if (!RECUR.includes(r.type)) throw new Error(`recurrence.type inválido: ${r.type}`);
    recurrence = { type: r.type };
    if (r.type === 'dias_semana') recurrence.days = Array.isArray(r.days) ? r.days.map(Number) : [];
    if (r.until) recurrence.until = str(r.until);
  }
  if (recurrence && !date) throw new Error('Tarefa recorrente precisa de "date" de início.');

  const done = !!input.done;
  const id = 'task_' + Date.now() + '_' + crypto.randomBytes(5).toString('hex');
  return {
    id,
    name,
    prio,
    resp: str(input.resp),
    cat: str(input.cat || input.categoria),
    date,
    time,
    durVal: str(input.durVal),
    durUnit,
    done,
    doneAt: done ? new Date().toISOString() : null,
    ownerId: owner.uid,
    ownerEmail: owner.email,
    shared: false,
    sharedWith: [],
    recurrence,
    completedOccurrences: Array.isArray(input.completedOccurrences) ? input.completedOccurrences.map(String) : [],
    createdAt: new Date().toISOString(),
  };
}

exports.buildTask = buildTask;
exports.toValue = toValue;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST.' });

  const expected = process.env.TASKS_API_TOKEN;
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const given = auth.replace(/^Bearer\s+/i, '');
  const ok =
    expected &&
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return json(401, { error: 'Token inválido.' });

  let sa;
  try {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
  } catch (e) {
    return json(500, { error: 'FIREBASE_SERVICE_ACCOUNT ausente ou inválida.' });
  }
  const owner = { uid: process.env.OWNER_UID, email: process.env.OWNER_EMAIL };
  if (!owner.uid || !owner.email) return json(500, { error: 'OWNER_UID/OWNER_EMAIL ausentes.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'JSON inválido.' });
  }
  const list = Array.isArray(payload.tasks) ? payload.tasks : payload.name || payload.nome ? [payload] : [];
  if (!list.length) return json(400, { error: 'Envie {"tasks":[...]} ou uma tarefa com "name".' });
  if (list.length > 50) return json(400, { error: 'Máximo de 50 tarefas por chamada.' });

  let tasks;
  try {
    tasks = list.map((t) => buildTask(t, owner));
  } catch (e) {
    return json(400, { error: e.message });
  }

  try {
    const token = await getAccessToken(sa);
    const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/tasks`;
    const created = [];
    for (const t of tasks) {
      const fields = {};
      for (const [k, v] of Object.entries(t)) fields[k] = toValue(v);
      const res = await fetch(`${base}/${t.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return json(502, { error: 'Falha ao gravar no Firestore.', detail, created });
      }
      created.push({ id: t.id, name: t.name });
    }
    return json(200, { ok: true, created });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
