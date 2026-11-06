// Compteur de tickets vendus.
// GET  : public, renvoie { online, paper, total, goal } (tickets HelloAsso + tickets papier).
// POST : réservé à l'admin (en-tête x-admin-password), enregistre le nombre de tickets papier vendus.
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
const CACHE_SECONDS = 120; // on n'interroge HelloAsso qu'une fois toutes les 2 minutes au plus

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
    const paper = Math.floor(Number(body && body.paper));
    if (!Number.isFinite(paper) || paper < 0 || paper > 100000) { res.status(400).json({ error: 'Nombre invalide.' }); return; }
    await pipeline([['SET', 'tickets:paper', paper]]);
    res.status(200).json({ ok: true, paper });
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  let online = null, paper = 0, error = null;
  try {
    if (configured()) {
      const [cached, p] = await pipeline([['GET', 'tickets:online'], ['GET', 'tickets:paper']]);
      paper = Number(p) || 0;
      if (cached !== null && cached !== undefined) online = Number(cached);
    }
    if (online === null) {
      online = await helloAssoCount();
      if (online !== null && configured()) await pipeline([['SET', 'tickets:online', online, 'EX', CACHE_SECONDS]]);
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
    error,
  });
};
