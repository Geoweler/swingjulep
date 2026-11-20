// functions/api/import.js — Fonction Cloudflare Pages
// Appel : GET /api/import?url=https://site-du-festival.tld
// Lit la page du festival côté serveur (donc sans blocage CORS) et renvoie du JSON :
// { ok, nom, dateDebut, dateFin, ville, lieu, prix, styles, notes, avertissements, debug }

const MAX_BYTES = 1500000;
const TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (compatible; SwingJulepImport/1.0; +https://swingjulep.geoweler.com)';

const MONTHS = {
  // français
  janvier: 1, janv: 1, jan: 1, 'février': 2, fevrier: 2, 'févr': 2, fevr: 2, 'fév': 2, fev: 2,
  mars: 3, mar: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  'août': 8, aout: 8, 'aoû': 8, septembre: 9, sept: 9, sep: 9, octobre: 10, oct: 10,
  novembre: 11, nov: 11, 'décembre': 12, decembre: 12, 'déc': 12, dec: 12,
  // anglais
  january: 1, february: 2, feb: 2, march: 3, april: 4, apr: 4, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, october: 10, november: 11, december: 12,
  // allemand
  januar: 1, februar: 2, 'märz': 3, maerz: 3, juni: 6, juli: 7, oktober: 10, dezember: 12,
};
const M = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const SEP = '(?:-|,|&|et|and|au|to|bis|till|until|through)';
const DAYLIST = `(?:\\d{1,2}\\s*${SEP}\\s*)*\\d{1,2}`;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û',
  uuml: 'ü', szlig: 'ß', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', hellip: '…', euro: '€', laquo: '«', raquo: '»' };

const COUNTRY_BY_TLD = { fr: 'France', de: 'Allemagne', nl: 'Pays-Bas', it: 'Italie', es: 'Espagne', pt: 'Portugal', ch: 'Suisse',
  be: 'Belgique', at: 'Autriche', uk: 'Royaume-Uni', se: 'Suède', no: 'Norvège', dk: 'Danemark', pl: 'Pologne', cz: 'Tchéquie', hr: 'Croatie' };
const COUNTRY_BY_CODE = { FR: 'France', DE: 'Allemagne', NL: 'Pays-Bas', IT: 'Italie', ES: 'Espagne', PT: 'Portugal', CH: 'Suisse',
  BE: 'Belgique', AT: 'Autriche', GB: 'Royaume-Uni', SE: 'Suède', NO: 'Norvège', DK: 'Danemark', PL: 'Pologne', CZ: 'Tchéquie', HR: 'Croatie', LU: 'Luxembourg' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function readMeta(html) {
  const meta = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const ar = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? '';
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = decodeEntities(attrs.content).trim();
  }
  return meta;
}

function readJsonLdEvent(html) {
  const nodes = [];
  const collect = (n) => {
    if (Array.isArray(n)) return n.forEach(collect);
    if (n && typeof n === 'object') { nodes.push(n); if (n['@graph']) collect(n['@graph']); }
  };
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { collect(JSON.parse(m[1].trim())); } catch (_) { /* JSON-LD invalide : ignoré */ } }
  return nodes.find((n) => /event|festival/i.test([].concat(n['@type'] || []).join(' ')) && (n.startDate || n.name)) || null;
}

function isoDay(v) {
  const m = typeof v === 'string' && v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normText(s) {
  return s.toLowerCase()
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/[–—−‒]/g, '-')
    .replace(/(\d)(st|nd|rd|th|er)(?![\p{L}])/gu, '$1')
    .replace(/(\d{1,2})\.(?=\s*\p{L})/gu, '$1')
    .replace(/(\d{1,2})\.(?=\s*-)/g, '$1')
    .replace(/\s+/g, ' ');
}

function mkDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}
const fmt = (dt) => dt.toISOString().slice(0, 10);

// Renvoie toutes les plages de dates plausibles, dans l'ordre du texte.
function findDateRanges(raw) {
  const t = normText(raw);
  const out = [];
  const push = (idx, s, e) => {
    if (!s || !e || e < s) return;
    if ((e - s) / 86400000 > 14) return; // une "plage" de plus de 15 jours n'est pas un festival
    out.push({ idx, start: fmt(s), end: fmt(e) });
  };
  const lst = (list) => { const n = list.match(/\d{1,2}/g).map(Number); return [n[0], n[n.length - 1]]; };
  const mo = (name) => MONTHS[name];
  let m;

  let re = new RegExp(`(?<![\\d./-])(${DAYLIST})\\s*(${M})(?![\\p{L}])\\.?,?\\s*(\\d{4})(?!\\d)`, 'gu');
  while ((m = re.exec(t))) { const [a, b] = lst(m[1]); const y = +m[3]; push(m.index, mkDate(y, mo(m[2]), a), mkDate(y, mo(m[2]), b)); }

  re = new RegExp(`(?<![\\p{L}])(${M})(?![\\p{L}])\\.?\\s*(${DAYLIST}),?\\s*(\\d{4})(?!\\d)`, 'gu');
  while ((m = re.exec(t))) { const [a, b] = lst(m[2]); const y = +m[3]; push(m.index, mkDate(y, mo(m[1]), a), mkDate(y, mo(m[1]), b)); }

  re = new RegExp(`(?<![\\d./-])(\\d{1,2})\\s*(${M})(?![\\p{L}])\\.?\\s*(?:(\\d{4})\\s*)?(?:-|au|to|bis|till|until|through)\\s*(\\d{1,2})\\s*(${M})(?![\\p{L}])\\.?,?\\s*(\\d{4})(?!\\d)`, 'gu');
  while ((m = re.exec(t))) {
    const m1 = mo(m[2]), m2 = mo(m[5]), y2 = +m[6];
    const y1 = m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2);
    push(m.index, mkDate(y1, m1, +m[1]), mkDate(y2, m2, +m[4]));
  }

  re = new RegExp(`(?<![\\p{L}])(${M})(?![\\p{L}])\\.?\\s*(\\d{1,2})\\s*(?:,?\\s*(\\d{4})\\s*)?(?:-|to|through|until)\\s*(${M})(?![\\p{L}])\\.?\\s*(\\d{1,2}),?\\s*(\\d{4})(?!\\d)`, 'gu');
  while ((m = re.exec(t))) {
    const m1 = mo(m[1]), m2 = mo(m[4]), y2 = +m[6];
    const y1 = m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2);
    push(m.index, mkDate(y1, m1, +m[2]), mkDate(y2, m2, +m[5]));
  }

  re = /(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)(?:\s*(?:-|to|au)\s*(20\d{2})-(\d{2})-(\d{2})(?!\d))?/g;
  while ((m = re.exec(t))) {
    const s = mkDate(+m[1], +m[2], +m[3]);
    push(m.index, s, m[4] ? mkDate(+m[4], +m[5], +m[6]) : s);
  }

  re = /(?<![\d.])(\d{1,2})\.?\s*-\s*(\d{1,2})[./](\d{1,2})[./](20\d{2})(?!\d)/g;
  while ((m = re.exec(t))) push(m.index, mkDate(+m[4], +m[3], +m[1]), mkDate(+m[4], +m[3], +m[2]));

  re = /(?<![\d.])(\d{1,2})[./](\d{1,2})[./](20\d{2})(?!\d)(?:\s*-\s*(\d{1,2})[./](\d{1,2})[./](20\d{2})(?!\d))?/g;
  while ((m = re.exec(t))) {
    const s = mkDate(+m[3], +m[2], +m[1]);
    push(m.index, s, m[4] ? mkDate(+m[6], +m[5], +m[4]) : s);
  }

  return out.sort((a, b) => a.idx - b.idx);
}

function pickDates(raw, todayIso) {
  const ranges = findDateRanges(raw);
  if (!ranges.length) return null;
  const limit = new Date(Date.parse(todayIso) - 7 * 86400000).toISOString().slice(0, 10);
  const upcoming = ranges.find((r) => r.end >= limit);
  return upcoming ? { ...upcoming, past: false } : { ...ranges[0], past: true };
}

function cleanTitle(title, siteName, host) {
  if (!title) return null;
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const hostCore = norm(host.replace(/^www\./, '').split('.')[0]);
  const isSite = (p) => {
    const n = norm(p);
    return !n || /^(home|accueil|welcome|bienvenue|officialsite|siteofficiel)$/.test(n) ||
      (siteName && n === norm(siteName)) || (hostCore.length > 3 && (hostCore.includes(n) || n.includes(hostCore)));
  };
  const beforePipe = t.split(/\s+[|•·]\s+/)[0];
  const parts = beforePipe.split(/\s+[–—-]\s+/);
  if (parts.length > 1) {
    const kept = parts.filter((p, i) => i === 0 || !isSite(p));
    if (kept.length !== parts.length) return kept.join(' – ').trim() || null;
  }
  return beforePipe.trim() || null;
}

function guessCity(primary) {
  const re = /(?<![\p{L}])(?:à|au|in|at|nach|en)\s+((?:[A-ZÀ-ÝÄÖÜ][\p{L}'’]+)(?:[ -](?:[A-ZÀ-ÝÄÖÜ][\p{L}'’]+|en|de|sur|la|le|les|del|della|di))*)/gu;
  let m;
  while ((m = re.exec(primary))) {
    const c = m[1].trim();
    const first = c.toLowerCase().split(/[ -]/)[0];
    if (MONTHS[first] || /^(Ligne|Direct|Live|Vente|Savoir|Famille)$/i.test(c)) continue;
    return c;
  }
  return null;
}

function guessPrice(primary, jsonLd) {
  const offers = jsonLd && [].concat(jsonLd.offers || []);
  if (offers && offers.length) {
    const vals = offers.map((o) => parseFloat(o.price ?? o.lowPrice)).filter((v) => v > 0);
    if (vals.length) return Math.round(Math.min(...vals));
  }
  const m = primary.match(/(?:à partir de|dès|from|ab|starting at|tickets? from)\s*(\d{2,4})\s*(?:€|eur)/i) ||
            primary.match(/(\d{2,4})\s*(?:€|eur(?:os?)?)(?!\s*(?:de remise|off|discount))/i) ||
            primary.match(/€\s*(\d{2,4})/);
  return m ? parseInt(m[1], 10) : null;
}

function guessStyles(primary, body) {
  const defs = [['Lindy Hop', /\blindy\b/i], ['Blues', /\bblues\b/i], ['Balboa', /\bbalboa\b/i],
                ['Switch', /\bswitch\b/i], ['Queer', /\bqueer\b/i], ['Solo', /\bsolo\b/i]];
  return defs.filter(([, r]) => r.test(primary) || (body.match(new RegExp(r.source, 'gi')) || []).length >= 3).map(([n]) => n);
}

function isPrivateHost(h) {
  return !h.includes('.') || /^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local') || h.endsWith('.internal');
}

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
    if (n >= max) { await reader.cancel(); break; }
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  const cs = ((res.headers.get('content-type') || '').match(/charset=([^;]+)/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(cs.trim()).decode(buf); } catch (_) { return new TextDecoder('utf-8').decode(buf); }
}

export async function onRequestGet({ request }) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return json({ ok: false, error: 'Appel depuis un autre site refusé.' }, 403);
  }
  const target = new URL(request.url).searchParams.get('url');
  let url;
  try { url = new URL(target); } catch (_) { return json({ ok: false, error: "Lien invalide (il doit commencer par https://)." }, 400); }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) {
    return json({ ok: false, error: 'Ce lien ne peut pas être lu.' }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, html;
  try {
    try {
      res = await fetch(url.href, {
        signal: ctrl.signal, redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'fr,en;q=0.8,de;q=0.5' },
      });
    } catch (e) {
      return json({ ok: false, error: e.name === 'AbortError'
        ? `Le site n'a pas répondu en ${TIMEOUT_MS / 1000} secondes.` : `Impossible de joindre le site (${e.message}).` });
    }
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? "Le site refuse les accès automatiques"
        : res.status === 404 ? 'Page introuvable' : res.status === 429 ? 'Le site limite les requêtes' : 'Le site a répondu avec une erreur';
      return json({ ok: false, error: `${why} (HTTP ${res.status}).` });
    }
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html|xml/i.test(ct)) return json({ ok: false, error: `Ce lien n'est pas une page web (type : ${ct.split(';')[0]}).` });
    html = await readLimited(res, MAX_BYTES);
  } finally { clearTimeout(timer); }

  const meta = readMeta(html);
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const ld = readJsonLdEvent(html);
  const body = htmlToText(html);
  const host = url.hostname;
  const sources = {};

  const description = meta['og:description'] || meta.description || meta['twitter:description'] || '';
  const primary = [titleTag && decodeEntities(titleTag), meta['og:title'], description, h1 && htmlToText(h1)].filter(Boolean).join(' · ');

  let nom = null;
  if (ld && ld.name) { nom = decodeEntities(String(ld.name)).trim(); sources.nom = 'json-ld'; }
  else if (meta['og:title']) { nom = cleanTitle(meta['og:title'], meta['og:site_name'], host); sources.nom = 'og:title'; }
  else if (titleTag) { nom = cleanTitle(titleTag, meta['og:site_name'], host); sources.nom = 'title'; }
  else if (h1) { nom = cleanTitle(htmlToText(h1), null, host); sources.nom = 'h1'; }

  if (nom && h1) {
    const h1t = htmlToText(h1).replace(/\s+/g, ' ').trim();
    const rest = nom.slice(h1t.length);
    if (h1t.length >= 4 && h1t.length < nom.length && nom.toLowerCase().startsWith(h1t.toLowerCase()) &&
        /^\s*[–—:-]\s*.*(festival|lindy|blues|swing|dance|weekend|exchange|camp)/i.test(rest)) { nom = h1t; sources.nom = 'h1'; }
  }

  const avertissements = [];
  const today = new Date().toISOString().slice(0, 10);
  let dateDebut = null, dateFin = null;
  const ldStart = ld && isoDay(ld.startDate);
  if (ldStart) { dateDebut = ldStart; dateFin = isoDay(ld.endDate) || ldStart; sources.dates = 'json-ld'; }
  else {
    const hit = pickDates(primary, today) || pickDates(body, today);
    if (hit) {
      dateDebut = hit.start; dateFin = hit.end;
      sources.dates = pickDates(primary, today) ? 'titre/description' : 'texte de la page';
      if (hit.past) avertissements.push(`Seules des dates passées ont été trouvées (${hit.start}) : vérifie l'année.`);
    }
  }

  let ville = null, lieu = null;
  if (ld && ld.location) {
    const loc = [].concat(ld.location)[0];
    if (typeof loc === 'string') lieu = loc;
    else if (loc && typeof loc === 'object') {
      lieu = loc.name || null;
      const addr = loc.address;
      if (typeof addr === 'string') ville = addr;
      else if (addr && addr.addressLocality) {
        const c = typeof addr.addressCountry === 'string' ? addr.addressCountry : (addr.addressCountry && addr.addressCountry.name);
        ville = addr.addressLocality + (c ? ', ' + (COUNTRY_BY_CODE[c.toUpperCase()] || c) : '');
      }
      if (ville) sources.ville = 'json-ld';
    }
  }
  if (!ville) {
    const c = guessCity(primary);
    if (c) {
      const tld = COUNTRY_BY_TLD[host.split('.').pop()];
      ville = tld ? `${c}, ${tld}` : c;
      sources.ville = 'devinée';
      avertissements.push('La ville a été devinée à partir du texte : à vérifier.');
    }
  }

  const prix = guessPrice(description || primary, ld);
  const styles = guessStyles(primary, body);
  const notes = description ? description.replace(/\s+/g, ' ').slice(0, 220) : null;

  if (body.length < 300 && !nom) avertissements.push("Presque aucun texte lu : le site se charge probablement par JavaScript, il faut remplir à la main.");
  else if (!dateDebut) avertissements.push('Dates non trouvées sur la page : à remplir à la main.');

  return json({
    ok: true, nom, dateDebut, dateFin, ville, lieu, prix, styles, notes, avertissements,
    debug: { urlFinale: res.url || url.href, statut: res.status, octetsLus: html.length, sources },
  });
}
