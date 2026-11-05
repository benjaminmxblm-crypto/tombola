// Statistiques pour la page admin, protégées par le mot de passe ADMIN_PASSWORD.
const crypto = require('crypto');
const { configured, pipeline, dayParis } = require('./_redis');

function okPassword(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toObject(arr) {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
  return o;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!okPassword(req.headers['x-admin-password'])) {
    res.status(401).json({ error: 'Mot de passe incorrect.' });
    return;
  }
  if (!configured()) {
    res.status(503).json({ error: "La base de données n'est pas encore connectée au projet Vercel." });
    return;
  }

  // 30 derniers jours, du plus ancien au plus récent
  const days = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) days.push(dayParis(new Date(now - i * 86400000)));

  const cmds = [
    ['GET', 'visits:total'], ['PFCOUNT', 'uv:total'],
    ['GET', 'clicks:total'], ['PFCOUNT', 'uc:total'],
    ['HGETALL', 'sources'], ['HGETALL', 'devices'],
  ];
  days.forEach((d) => cmds.push(['GET', 'visits:day:' + d], ['PFCOUNT', 'uv:day:' + d], ['GET', 'clicks:day:' + d]));

  try {
    const r = await pipeline(cmds);
    const series = days.map((d, i) => ({
      day: d,
      visits: Number(r[6 + i * 3]) || 0,
      visitors: Number(r[7 + i * 3]) || 0,
      clicks: Number(r[8 + i * 3]) || 0,
    }));
    res.status(200).json({
      updatedAt: new Date().toISOString(),
      totals: {
        visits: Number(r[0]) || 0,
        visitors: Number(r[1]) || 0,
        clicks: Number(r[2]) || 0,
        clickers: Number(r[3]) || 0,
      },
      sources: toObject(r[4]),
      devices: toObject(r[5]),
      series,
    });
  } catch (e) {
    res.status(502).json({ error: 'Impossible de lire les statistiques pour le moment.' });
  }
};
