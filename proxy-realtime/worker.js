// Proxy del tempo reale per i siti delle UdR (Cloudflare Worker).
//
// Tiene le credenziali delle API Astral (secret CLIENT_ID e CLIENT_SECRET di Cloudflare, mai nel sito),
// chiede le corse di oggi a /realtime/api/transit/tripServiceRecord/trips e restituisce al sito solo
// i dati che servono: corsa del GTFS, stato, ritardo e passaggi alle fermate. Niente veicoli né dati interni.
//
// Indirizzi (tutti GET):
//   /corse     corse di oggi in attesa o in servizio, per il sito (rinnovate al massimo ogni CACHE_SEC secondi)
//   /agenzie   agenzie presenti nelle corse di oggi, con esempi (per impostare AGENCY_ID)  } solo con
//   /prova     le prime corse di oggi con i loro identificativi (per il confronto col GTFS) } DEBUG = 1
//              (/prova?agenzia=CODICE per provare un codice prima di impostarlo)
//   /diagnosi  prova più varianti di richiesta alle API e dice quali accettano               }
//
// Variabili (Settings → Variables and Secrets del Worker):
//   CLIENT_ID, CLIENT_SECRET  secret: credenziali OAuth2 delle API (flusso client credentials)
//   AGENCY_ID                 codice agenzia dell'UdR (uno o più, separati da virgola): obbligatorio per /corse
//   ALLOWED_ORIGINS           siti che possono leggere i dati, separati da virgola; "https://*.astralspa.it" vale per
//                             tutti i sottodomini (es. https://astral-spa.github.io,https://*.astralspa.it)
//   DEBUG                     1 = attiva /agenzie e /prova, da usare durante la configurazione e poi togliere

const VERSIONE = "2026-11-10b";
const HOST = "https://tpl-admin.astralspa.it";
const CACHE_SEC = 20;          // il sito interroga spesso: le API Astral al massimo una volta ogni 20 secondi
const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const STATI = ["PENDING", "IN_SERVICE"];

let token = null;              // token OAuth2 riusato finché non scade (per istanza del Worker)
let tokenScade = 0;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ errore: "metodo non ammesso" }, 405, cors);
    if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
      return json({ errore: "credenziali mancanti: impostare i secret CLIENT_ID e CLIENT_SECRET" }, 500, cors);
    }
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/corse") {
        if (!agenzie(env).length) return json({ errore: "impostare la variabile AGENCY_ID (codici in /agenzie)" }, 500, cors);
        return await corse(request, env, ctx, cors);
      }
      if (["/agenzie", "/prova", "/diagnosi"].includes(path) && env.DEBUG !== "1") {
        return json({ errore: "indirizzo di configurazione disattivato (variabile DEBUG)" }, 403, cors);
      }
      if (path === "/agenzie") return json(await elencoAgenzie(env), 200, cors);
      if (path === "/prova") return json(await prova(env, new URL(request.url).searchParams.get("agenzia")), 200, cors);
      if (path === "/diagnosi") return json(await diagnosi(env), 200, cors);
      return json({ errore: "indirizzo sconosciuto", versione: VERSIONE, indirizzi: ["/corse", "/agenzie", "/prova", "/diagnosi"],
        siti_ammessi: sitiAmmessi(env) }, 404, cors);
    } catch (e) {
      return json({ errore: String(e.message || e), versione: VERSIONE }, 502, cors);
    }
  },
};

async function corse(request, env, ctx, cors) {
  // una sola risposta condivisa per tutti i visitatori, rinnovata ogni CACHE_SEC secondi
  const cache = caches.default;
  const chiave = new Request(new URL("/corse", request.url).toString());
  const salvata = await cache.match(chiave);
  if (salvata) return withHeaders(salvata, cors);

  const trips = await tuttiITrip(env, { status: STATI });
  const dati = {
    aggiornato: new Date().toISOString(),
    corse: trips.map(t => ({
      trip: t.originalTripId || t.tripId,        // trip_id del GTFS
      linea: t.routeId,
      stato: t.status,                             // PENDING, IN_SERVICE
      ritardo: t.delay,                            // secondi (positivo = in ritardo)
      prossima: t.nextStopIndex,                   // indice della prossima fermata nella corsa
      percentuale: t.percentage,
      segnale: t.lastSignal,                       // ultimo segnale del veicolo
      fermate: (t.stops || []).map(s => [s.delay ?? null, s.expectedArrival ?? null, s.visitedOn ?? null]),
      soppresse: t.suppressedStops || [],
    })),
  };
  const risposta = json(dati, 200, { "Cache-Control": `public, max-age=${CACHE_SEC}` });
  ctx.waitUntil(cache.put(chiave, risposta.clone()));
  return withHeaders(risposta, cors);
}

async function prova(env, agenzia) {
  const trips = await tuttiITrip(env, agenzia ? { agencyId: [agenzia] } : {}, 1, 5);
  return trips.map(t => ({
    id: t.id, agencyId: t.agencyId, routeId: t.routeId, tripId: t.tripId, originalTripId: t.originalTripId,
    status: t.status, serviceDate: t.serviceDate, delay: t.delay, narrative: t.narrative,
    fermate: (t.stops || []).slice(0, 3).map(s => ({ id: s.id, title: s.title })),
  }));
}

async function elencoAgenzie(env) {
  // le API non hanno un elenco agenzie raggiungibile: si ricava dalle corse di oggi (fino a 1000)
  const trips = await tuttiITrip(env, {}, 5, 200);
  const agenzie = {};
  for (const t of trips) {
    const a = agenzie[t.agencyId] || (agenzie[t.agencyId] = { corse: 0, esempi: [] });
    a.corse++;
    if (a.esempi.length < 3) a.esempi.push({ routeId: t.routeId, originalTripId: t.originalTripId, linea: t.narrative });
  }
  return { corseLette: trips.length, agenzie };
}

async function diagnosi(env) {
  // ogni variante: metodo, percorso, corpo; risponde con lo stato HTTP e l'inizio della risposta
  const { from, to } = oggiRoma();
  const tutti = { agencyId: [], vehicleId: [], narratives: [], status: [], city: [], from: null, to: null };
  const trips = "/realtime/api/transit/tripServiceRecord/trips";
  const varianti = [
    ["documentazione, senza date", "POST", trips + "?page=1&size=5", tutti],
    ["documentazione, senza parametri", "POST", trips, tutti],
    ["date UTC", "POST", trips + "?page=1&size=5", { ...tutti, from, to }],
    ["date UTC, solo in servizio", "POST", trips + "?page=1&size=5", { ...tutti, from, to, status: ["IN_SERVICE"] }],
    ["corpo vuoto", "POST", trips + "?page=1&size=5", {}],
    ["seconda pagina", "POST", trips + "?page=2&size=5", { ...tutti, from, to }],
    ["stati possibili", "GET", "/realtime/api/transit/enum/tripStatus"],
    ["città", "GET", "/realtime/api/transit/values/cities"],
    ["agenzie (city-agency)", "GET", "/realtime/api/client/city-agency"],
    ["agenzie (agency)", "GET", "/realtime/api/client/agency"],
  ];
  const out = { versione: VERSIONE, from, to, risultati: [] };
  const tok = await accesso(env, false);
  for (const [nome, method, path, body] of varianti) {
    try {
      const r = await fetch(HOST + path, {
        method, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + tok },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      out.risultati.push({ nome, http: r.status, risposta: (await r.text()).replace(/\s+/g, " ").slice(0, 300) });
    } catch (e) {
      out.risultati.push({ nome, errore: String(e.message || e) });
    }
  }
  return out;
}

async function tuttiITrip(env, filtri, maxPagine = MAX_PAGES, size = PAGE_SIZE) {
  const { from, to } = oggiRoma();
  const body = { agencyId: agenzie(env), vehicleId: [], narratives: [], status: [], city: [], from, to, ...filtri };
  const out = [];
  for (let page = 1; page <= maxPagine; page++) {  // le API numerano le pagine da 1 (page=0 dà errore 400)
    const r = await api(env, "POST", `/realtime/api/transit/tripServiceRecord/trips?page=${page}&size=${size}`, body);
    out.push(...(r.data || []));
    if (page >= (r.totalPage || 0)) break;
  }
  return out;
}

async function api(env, method, path, body, nuovoToken = false) {
  const r = await fetch(HOST + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + await accesso(env, nuovoToken) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && !nuovoToken) return api(env, method, path, body, true);  // token scaduto: uno nuovo
  if (!r.ok) {
    const motivo = (await r.text()).replace(/\s+/g, " ").slice(0, 400);  // la spiegazione delle API, se c'è
    throw new Error(`API Astral ${path.split("?")[0]}: HTTP ${r.status}${motivo ? " — " + motivo : ""}`);
  }
  return r.json();
}

async function accesso(env, nuovo) {
  if (!nuovo && token && Date.now() < tokenScade) return token;
  const r = await fetch(HOST + "/uaa/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token OAuth2: HTTP ${r.status} (controllare CLIENT_ID e CLIENT_SECRET)`);
  const t = await r.json();
  token = t.access_token;
  tokenScade = Date.now() + Math.max(60, (t.expires_in || 3600) - 60) * 1000;  // rinnovato un minuto prima
  return token;
}

function agenzie(env) {
  return (env.AGENCY_ID || "").split(",").map(s => s.trim()).filter(Boolean);
}

function oggiRoma() {
  // giornata di oggi in Italia (00:00:00–23:59:59, ora legale compresa) scritta in UTC come negli esempi
  // della documentazione: il 3/11 diventa 2026-11-02T23:00:00.000Z – 2026-11-03T22:59:59.000Z
  const ora = new Date();
  const [a, m, g] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(ora).split("-").map(Number);
  const mezzanotte = Date.UTC(a, m - 1, g) - offsetRoma(new Date(Date.UTC(a, m - 1, g, 12))) * 60000;
  const fine = Date.UTC(a, m - 1, g, 23, 59, 59) - offsetRoma(new Date(Date.UTC(a, m - 1, g, 12))) * 60000;
  return { from: new Date(mezzanotte).toISOString(), to: new Date(fine).toISOString() };
}

function offsetRoma(data) {
  // minuti di differenza tra l'ora italiana e UTC in quella data (60 d'inverno, 120 d'estate)
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(data).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - data.getTime()) / 60000;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const ammessi = sitiAmmessi(env);
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (ammessi.some(a => origineAmmessa(origin, a))) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function sitiAmmessi(env) {
  // tollerante a come si scrive il valore nel pannello: spazi, virgolette, asterischi tipografici, barra finale
  return (env.ALLOWED_ORIGINS || "").split(/[,;\s]+/)
    .map(s => s.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/[∗＊⁎]/g, "*").replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

function origineAmmessa(origin, voce) {
  // "https://*.astralspa.it" ammette https://udr7.astralspa.it ecc. (un solo livello, solo quello schema)
  const m = voce.match(/^(https?:\/\/)\*\.(.+)$/);
  if (!m) return origin === voce;
  return origin.startsWith(m[1]) && /^[a-z0-9-]+$/i.test(origin.slice(m[1].length, -(m[2].length + 1))) &&
    origin.endsWith("." + m[2]);
}

function json(dati, status, headers = {}) {
  return new Response(JSON.stringify(dati), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function withHeaders(risposta, headers) {
  const r = new Response(risposta.body, risposta);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
