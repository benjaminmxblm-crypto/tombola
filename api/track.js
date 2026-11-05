// Enregistre une visite ou un clic sur « Je prends mes tickets ».
// Aucune donnée personnelle : un identifiant aléatoire par navigateur sert
// seulement à compter les visiteurs uniques (HyperLogLog, non réversible).
const { configured, pipeline, dayParis } = require('./_redis');

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|headless|lighthouse/i;
const RETENTION = 60 * 60 * 24 * 400; // ~13 mois

function source(ref, src) {
  if (src) return String(src).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'autre';
  if (!ref) return 'direct';
  let host = '';
  try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { return 'autre'; }
  if (/facebook|fb\.|messenger/.test(host)) return 'facebook';
  if (/instagram/.test(host)) return 'instagram';
  if (/whatsapp/.test(host)) return 'whatsapp';
  if (/google/.test(host)) return 'google';
  if (/helloasso/.test(host)) return 'helloasso';
  if (/vercel\.app$/.test(host)) return 'direct';
  return host.slice(0, 40) || 'autre';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const ua = req.headers['user-agent'] || '';
  if (BOTS.test(ua) || !configured()) { res.status(204).end(); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const type = body.type === 'click' ? 'click' : 'visit';
  const vid = String(body.vid || '').slice(0, 40);
  const day = dayParis();
  const device = /mobi|android|iphone|ipad/i.test(ua) ? 'mobile' : 'ordinateur';
  const cmds = [];

  if (type === 'visit') {
    cmds.push(['INCR', 'visits:total']);
    cmds.push(['INCR', 'visits:day:' + day], ['EXPIRE', 'visits:day:' + day, RETENTION]);
    cmds.push(['HINCRBY', 'sources', source(body.ref, body.src), 1]);
    cmds.push(['HINCRBY', 'devices', device, 1]);
    if (vid) {
      cmds.push(['PFADD', 'uv:total', vid]);
      cmds.push(['PFADD', 'uv:day:' + day, vid], ['EXPIRE', 'uv:day:' + day, RETENTION]);
    }
  } else {
    cmds.push(['INCR', 'clicks:total']);
    cmds.push(['INCR', 'clicks:day:' + day], ['EXPIRE', 'clicks:day:' + day, RETENTION]);
    if (vid) cmds.push(['PFADD', 'uc:total', vid]);
  }

  try { await pipeline(cmds); } catch (e) { /* le suivi ne doit jamais gêner la page */ }
  res.status(204).end();
};
