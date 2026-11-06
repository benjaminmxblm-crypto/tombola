// Compteur de tickets vendus.
// GET  : public, renvoie { online, paper, total, goal, events } (tickets HelloAsso + tickets papier).
//        events = les dernières ventes réelles (anonymes) : { n, src: 'online' | 'paper', at }.
// POST : réservé à l'admin (en-tête x-admin-password) :
//        { add: n }   ajoute n tickets papier vendus (crée une notification « vente papier ») ;
//        { paper: n } corrige le total papier (sans notification).
//
// Variables d'environnement Vercel :
//   HELLOASSO_CLIENT_ID / HELLOASSO_CLIENT_SECRET  (HelloAsso > Mon compte > Intégrations et API)
//   ADMIN_PASSWORD, et la base Upstash déjà utilisée pour les statistiques.
const crypto = require('crypto');
const { configured, pipeline } = require('./_redis');

const ORG = 'les-p-tits-rennevillois';
const FORM_TYPE = 'Event';
const FORM_SLUG = 'tombola';
const PRICE_CENTS = 200;
const GOAL = 4000;
const CACHE_SECONDS = 60; // on n'interroge HelloAsso qu'une fois par minute au plus
const EVENTS_KEEP = 20;

function okPassword(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function helloAssoCount() {
  const id = process.env.HELLOASSO_CLIENT_ID, secret = process.env.HELLOASSO_CLIENT_SECRET;
  if (!id || !secret) return null;
  const t = await fetch('https://api.helloasso.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!t.ok) throw new Error('HelloAsso token ' + t.status);
  const { access_token } = await t.json();

  let count = 0;
  for (let page = 1; page <= 50; page++) {
    const url = `https://api.helloasso.com/v5/organizations/${ORG}/forms/${FORM_TYPE}/${FORM_SLUG}/items`
      + `?pageSize=100&pageIndex=${page}&itemStates=Processed&itemStates=Registered`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token, accept: 'application/json' } });
    if (!r.ok) throw new Error('HelloAsso items ' + r.status);
    const j = await r.json();
    const data = j.data || [];
    // un article = un ticket ; un éventuel lot de plusieurs tickets compte pour son montant / 2 €
    data.forEach((it) => { count += it.amount > PRICE_CENTS ? Math.round(it.amount / PRICE_CENTS) : 1; });
    const total = j.pagination && j.pagination.totalPages;
    if (!data.length || (total && page >= total) || data.length < 100) break;
  }
  return count;
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    if (!okPassword(req.headers['x-admin-password'])) { res.status(401).json({ error: 'Mot de passe incorrect.' }); return; }
    if (!configured()) { res.status(503).json({ error: "La base de données n'est pas connectée." }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    if (body.add !== undefined) {
      const add = Math.floor(Number(body.add));
      if (!Number.isFinite(add) || add < 1 || add > 1000) { res.status(400).json({ error: 'Nombre invalide.' }); return; }
      const ev = JSON.stringify({ n: add, src: 'paper', at: Date.now() });
      const [paper] = await pipeline([['INCRBY', 'tickets:paper', add], ['LPUSH', 'tickets:events', ev], ['LTRIM', 'tickets:events', 0, EVENTS_KEEP - 1]]);
      res.status(200).json({ ok: true, paper: Number(paper) });
      return;
    }
    const paper = Math.floor(Number(body.paper));
    if (!Number.isFinite(paper) || paper < 0 || paper > 100000) { res.status(400).json({ error: 'Nombre invalide.' }); return; }
    await pipeline([['SET', 'tickets:paper', paper]]);
    res.status(200).json({ ok: true, paper });
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
  let online = null, paper = 0, error = null, events = [];
  try {
    if (configured()) {
      const [cached, p, evs] = await pipeline([['GET', 'tickets:online'], ['GET', 'tickets:paper'], ['LRANGE', 'tickets:events', 0, 9]]);
      paper = Number(p) || 0;
      events = (evs || []).map((e) => { try { return JSON.parse(e); } catch (x) { return null; } }).filter(Boolean);
      if (cached !== null && cached !== undefined) online = Number(cached);
    }
    if (online === null) {
      online = await helloAssoCount();
      if (online !== null && configured()) {
        // nouvelle(s) vente(s) en ligne depuis la dernière fois → une notification
        const [last] = await pipeline([['GETSET', 'tickets:online:last', online], ['SET', 'tickets:online', online, 'EX', CACHE_SECONDS]]);
        const diff = last === null || last === undefined ? 0 : online - Number(last);
        if (diff > 0) {
          const ev = { n: diff, src: 'online', at: Date.now() };
          await pipeline([['LPUSH', 'tickets:events', JSON.stringify(ev)], ['LTRIM', 'tickets:events', 0, EVENTS_KEEP - 1]]);
          events.unshift(ev);
        }
      }
    }
  } catch (e) {
    error = 'HelloAsso indisponible';
  }
  res.status(200).json({
    online: online || 0,
    paper,
    total: (online || 0) + paper,
    goal: GOAL,
    helloasso: online !== null,
    events: events.slice(0, 10),
    error,
  });
};
