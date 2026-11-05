// Petit client Redis (Upstash REST) sans dépendance.
// Variables d'environnement fournies par l'intégration Upstash de Vercel :
// KV_REST_API_URL / KV_REST_API_TOKEN, ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function configured() {
  return Boolean(URL_ && TOKEN);
}

async function pipeline(commands) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('Redis ' + r.status);
  const out = await r.json();
  return out.map((x) => x.result);
}

// Date du jour à l'heure de Paris, au format AAAA-MM-JJ.
function dayParis(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}

module.exports = { configured, pipeline, dayParis };
