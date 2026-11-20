// Ventes détaillées pour la page /ventes (réservée à l'admin, en-tête x-admin-password).
//
// Aucune donnée personnelle n'est stockée ici : l'export HelloAsso est lu dans le navigateur
// de l'admin, qui n'envoie que des totaux (tickets par vendeur et par jour).
//
// GET  → { online, paper, levels, aliases, printed }
// POST { action: 'import', online: { tickets, amount, orders, lots5, singles, bySeller, byDay, lastOrder } }
//      { action: 'paper', seller, n }          vente papier (+ notification anonyme sur le site)
//      { action: 'paperSet', seller, n }       correction du total papier d'un vendeur (sans notification)
//      { action: 'level', seller, level }      niveau du vendeur pour le concours
//      { action: 'alias', raw, name }          regroupe une saisie HelloAsso sous un nom de vendeur
//      { action: 'printed', ids: [...] }       talons HelloAsso déjà imprimés (numéros de billet)
//      { action: 'unprint' }                   tout remettre « à imprimer »
const crypto = require('crypto');
const { configured, pipeline, dayParis } = require('./_redis');

const EVENTS_KEEP = 20;
const LEVELS = ['', 'Maternelles', 'CP · CE1 · CE2', 'CM1 · CM2'];

function okPassword(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const toObj = (arr, num) => {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = num ? Number(arr[i + 1]) || 0 : arr[i + 1];
  return o;
};
const int = (v, min, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!okPassword(req.headers['x-admin-password'])) { res.status(401).json({ error: 'Mot de passe incorrect.' }); return; }
  if (!configured()) { res.status(503).json({ error: "La base de données n'est pas connectée." }); return; }

  try {
    if (req.method === 'GET') {
      const [online, paperBy, paperDay, levels, aliases, printed] = await pipeline([
        ['GET', 'sales:online'], ['HGETALL', 'paper:bysel'], ['HGETALL', 'paper:byday'],
        ['HGETALL', 'sales:levels'], ['HGETALL', 'sales:aliases'], ['SMEMBERS', 'stubs:printed'],
      ]);
      const bySeller = toObj(paperBy, true);
      res.status(200).json({
        online: online ? JSON.parse(online) : null,
        paper: { bySeller, byDay: toObj(paperDay, true), total: Object.values(bySeller).reduce((s, n) => s + n, 0) },
        levels: toObj(levels), aliases: toObj(aliases), printed: printed || [],
      });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const a = body.action;

    if (a === 'import') {
      const o = body.online || {};
      const clean = {
        tickets: int(o.tickets, 0, 100000) || 0, amount: Number(o.amount) || 0, orders: int(o.orders, 0, 100000) || 0,
        lots5: int(o.lots5, 0, 100000) || 0, singles: int(o.singles, 0, 100000) || 0,
        bySeller: {}, byDay: {}, lastOrder: String(o.lastOrder || '').slice(0, 30), importedAt: new Date().toISOString(),
      };
      Object.entries(o.bySeller || {}).slice(0, 300).forEach(([k, v]) => { const n = Number(v); if (k && n > 0) clean.bySeller[cleanName(k)] = Math.round(n * 10) / 10; });
      Object.entries(o.byDay || {}).slice(0, 120).forEach(([k, v]) => { if (/^\d{4}-\d{2}-\d{2}$/.test(k)) clean.byDay[k] = int(v, 0, 100000) || 0; });
      // le compteur public s'en sert tant que les clés HelloAsso ne sont pas branchées
      await pipeline([['SET', 'sales:online', JSON.stringify(clean)], ['SET', 'tickets:online:import', clean.tickets]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (a === 'paper' || a === 'paperSet') {
      const seller = cleanName(body.seller) || 'Non renseigné';
      if (a === 'paper') {
        const n = int(body.n, 1, 1000);
        if (n === null) { res.status(400).json({ error: 'Nombre invalide.' }); return; }
        const ev = JSON.stringify({ n, src: 'paper', at: Date.now() });
        await pipeline([
          ['HINCRBY', 'paper:bysel', seller, n], ['HINCRBY', 'paper:byday', dayParis(), n], ['INCRBY', 'tickets:paper', n],
          ['LPUSH', 'tickets:events', ev], ['LTRIM', 'tickets:events', 0, EVENTS_KEEP - 1],
        ]);
      } else {
        const n = int(body.n, 0, 100000);
        if (n === null) { res.status(400).json({ error: 'Nombre invalide.' }); return; }
        const [old] = await pipeline([['HGET', 'paper:bysel', seller]]);
        const diff = n - (Number(old) || 0);
        const cmds = [n ? ['HSET', 'paper:bysel', seller, n] : ['HDEL', 'paper:bysel', seller], ['INCRBY', 'tickets:paper', diff]];
        await pipeline(cmds);
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (a === 'level') {
      const seller = cleanName(body.seller); const level = LEVELS.includes(body.level) ? body.level : '';
      if (!seller) { res.status(400).json({ error: 'Vendeur manquant.' }); return; }
      await pipeline([level ? ['HSET', 'sales:levels', seller, level] : ['HDEL', 'sales:levels', seller]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (a === 'alias') {
      const raw = cleanName(body.raw).toLowerCase(); const name = cleanName(body.name);
      if (!raw) { res.status(400).json({ error: 'Saisie manquante.' }); return; }
      await pipeline([name ? ['HSET', 'sales:aliases', raw, name] : ['HDEL', 'sales:aliases', raw]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (a === 'printed') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x).replace(/[^\w-]/g, '').slice(0, 40)).filter(Boolean).slice(0, 5000);
      if (ids.length) await pipeline([['SADD', 'stubs:printed', ...ids]]);
      res.status(200).json({ ok: true, n: ids.length });
      return;
    }

    if (a === 'unprint') {
      await pipeline([['DEL', 'stubs:printed']]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    res.status(502).json({ error: 'Base de données indisponible pour le moment.' });
  }
};
