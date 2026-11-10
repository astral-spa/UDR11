# Proxy del tempo reale (Cloudflare Worker)

Il sito delle UdR è una pagina che gira nel browser: chi la ispeziona vede tutto. Le credenziali delle API
Astral (`client_id` e `client_secret`) quindi **non stanno nel sito**, ma in questo piccolo servizio su
Cloudflare. Il proxy ottiene il token, chiede le corse di oggi alle API e restituisce al sito solo corsa del GTFS,
stato, ritardo e passaggi alle fermate (niente veicoli né dati interni). Risponde a tutti i visitatori con lo
stesso dato, rinnovato al massimo ogni 20 secondi: le API Astral ricevono poche richieste qualunque sia il traffico.

Il codice è in `worker.js`; non contiene segreti, per cui può stare anche in un repository pubblico.

## Attivarlo dal pannello di Cloudflare (circa 10 minuti, gratuito)

1. Crea un account su https://dash.cloudflare.com/sign-up (basta l'email; il piano gratuito regge 100.000
   richieste al giorno).
2. Nel menu a sinistra: **Workers & Pages** → **Create** → **Create Worker** (modello «Hello World»). Come nome
   scrivi `udr-realtime` e premi **Deploy**.
3. Premi **Edit code**, cancella tutto il codice di esempio, incolla il contenuto di `worker.js` e premi **Deploy**.
4. Torna al Worker → **Settings** → **Variables and Secrets** → **Add** e inserisci:

   | Tipo   | Nome              | Valore                                   |
   |--------|-------------------|------------------------------------------|
   | Secret | `CLIENT_ID`       | il client id delle API Astral            |
   | Secret | `CLIENT_SECRET`   | il client secret delle API Astral        |
   | Text   | `ALLOWED_ORIGINS` | `https://astral-spa.github.io,https://*.astralspa.it` |
   | Text   | `DEBUG`           | `1` (solo per la configurazione)         |
   | Text   | `AGENCY_ID`       | il codice agenzia dell'UdR (punto 5)     |

   I *Secret* dopo il salvataggio non sono più leggibili da nessuno, neanche da te: si possono solo sostituire.
5. Apri nel browser `https://udr-realtime.<il-tuo-nome>.workers.dev/agenzie` (l'indirizzo esatto è in alto nella
   pagina del Worker). Compare l'elenco delle agenzie: il codice dell'UdR va in `AGENCY_ID`. Se un proxy serve più
   UdR, si scrivono più codici separati da virgola.
6. Apri `…/prova`: mostra le prime corse di oggi con i loro identificativi. Il campo `originalTripId` deve essere
   uguale al `trip_id` del GTFS del sito (es. `L1_SCLFER0710A1_SSIn uscitaA1A_SS`), altrimenti il sito non può
   abbinare le corse.
7. Apri `…/corse`: sono i dati che userà il sito. Se tutto va, metti `DEBUG` a `0`.

L'indirizzo del Worker (`https://udr-realtime.<il-tuo-nome>.workers.dev`) va in `REALTIME` in testa a
`sito-mappe/build_data.py`. Quello attivo è `https://udr-realtime.antonini1971.workers.dev`, con
`AGENCY_ID` = `UdR11AirCampania`.

Note sulle API (diverse dalla documentazione): le pagine si numerano da 1 (`page=0` dà errore 400) e l'elenco
agenzie `/realtime/api/client/agency` non esiste (404), per cui `/agenzie` le ricava dalle corse di oggi. Le
credenziali vedono le corse di tutte le aziende: per questo `/corse` richiede `AGENCY_ID` e gli indirizzi di
configurazione vanno spenti (`DEBUG` = `0`). I dati per singola fermata (`delay`, `expectedArrival`, `visitedOn`)
per ora arrivano vuoti: il sito usa il ritardo della corsa.

Lo stesso Worker può servire anche le altre UdR (per esempio `UdR10AutolineeTroiani`, `UdR2AutoserviziTroiani`,
`UdR7AutoserviziTroiani`, `BusInternationalService`): basta aggiungerne il codice in `AGENCY_ID`, separato da
virgola, e `REALTIME` nel loro `build_data.py`.

Con un dominio proprio (per esempio `https://udr7.astralspa.it`) il sito deve essere ammesso in `ALLOWED_ORIGINS`:
`https://*.astralspa.it` vale per tutti i sottodomini di astralspa.it.

## Messaggi di errore

| Risposta                                   | Cosa fare                                                      |
|--------------------------------------------|----------------------------------------------------------------|
| `credenziali mancanti`                     | mancano i secret `CLIENT_ID` / `CLIENT_SECRET`                 |
| `token OAuth2: HTTP 401`                   | client id o secret sbagliati                                   |
| `impostare la variabile AGENCY_ID`         | inserire il codice agenzia (punto 5)                           |
| `Page index must not be less than zero`    | codice vecchio: ricaricare `worker.js` aggiornato              |
| `API Astral …: HTTP 403`                   | le credenziali non hanno i permessi per quell'agenzia          |
| `indirizzo di configurazione disattivato`  | `/agenzie` e `/prova` funzionano solo con `DEBUG` = `1`         |

## In alternativa, dalla riga di comando

Con Node.js installato, da questa cartella: `npx wrangler login`, `npx wrangler secret put CLIENT_ID`,
`npx wrangler secret put CLIENT_SECRET`, poi imposta `AGENCY_ID` in `wrangler.toml` e `npx wrangler deploy`.
