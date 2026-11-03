// Proxy del tempo reale per i siti delle UdR (Cloudflare Worker).
//
// Tiene le credenziali delle API Astral (secret CLIENT_ID e CLIENT_SECRET di Cloudflare, mai nel sito),
// chiede le corse di oggi a /realtime/api/transit/tripServiceRecord/trips e restituisce al sito solo
// i dati che servono: corsa del GTFS, stato, ritardo e passaggi alle fermate. Niente veicoli né dati interni.
//
// Indirizzi (tutti GET):
//   /corse     corse di oggi in attesa o in servizio, per il sito (rinnovate al massimo ogni CACHE_SEC secondi)
//   /agenzie   codici agenzia visibili con le credenziali (per impostare AGENCY_ID)        } solo con
//   /prova     le prime corse di oggi con i loro identificativi (per il confronto col GTFS) } DEBUG = 1
//
// Variabili (Settings → Variables and Secrets del Worker):
//   CLIENT_ID, CLIENT_SECRET  secret: credenziali OAuth2 delle API (flusso client credentials)
//   AGENCY_ID                 codice agenzia dell'UdR (uno o più, separati da virgola): obbligatorio per /corse
//   ALLOWED_ORIGINS           siti che possono leggere i dati, separati da virgola (es. https://astral-spa.github.io)
//   DEBUG                     1 = attiva /agenzie e /prova, da usare durante la configurazione e poi togliere

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
      if ((path === "/agenzie" || path === "/prova") && env.DEBUG !== "1") {
        return json({ errore: "indirizzo di configurazione disattivato (variabile DEBUG)" }, 403, cors);
      }
      if (path === "/agenzie") return json(await api(env, "GET", "/realtime/api/client/agency"), 200, cors);
      if (path === "/prova") return json(await prova(env), 200, cors);
      return json({ errore: "indirizzo sconosciuto", indirizzi: ["/corse", "/agenzie", "/prova"] }, 404, cors);
    } catch (e) {
      return json({ errore: String(e.message || e) }, 502, cors);
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

async function prova(env) {
  const trips = await tuttiITrip(env, {}, 1, 5);
  return trips.map(t => ({
    id: t.id, agencyId: t.agencyId, routeId: t.routeId, tripId: t.tripId, originalTripId: t.originalTripId,
    status: t.status, serviceDate: t.serviceDate, delay: t.delay, narrative: t.narrative,
    fermate: (t.stops || []).slice(0, 3).map(s => ({ id: s.id, title: s.title })),
  }));
}

async function tuttiITrip(env, filtri, maxPagine = MAX_PAGES, size = PAGE_SIZE) {
  const { from, to } = oggiRoma();
  const body = { agencyId: agenzie(env), vehicleId: [], narratives: [], status: [], city: [], from, to, ...filtri };
  const out = [];
  for (let page = 0; page < maxPagine; page++) {
    const r = await api(env, "POST", `/realtime/api/transit/tripServiceRecord/trips?page=${page}&size=${size}`, body);
    out.push(...(r.data || []));
    if (page + 1 >= (r.totalPage || 0)) break;
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
  if (!r.ok) throw new Error(`API Astral ${path.split("?")[0]}: HTTP ${r.status}`);
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
  // giornata di oggi in Italia, con il fuso giusto (ora legale compresa): 00:00:00–23:59:59
  const ora = new Date();
  const giorno = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(ora);  // 2026-11-03
  const fuso = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", timeZoneName: "longOffset" })
    .formatToParts(ora).find(p => p.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return { from: `${giorno}T00:00:00${fuso}`, to: `${giorno}T23:59:59${fuso}` };
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const ammessi = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (ammessi.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
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
