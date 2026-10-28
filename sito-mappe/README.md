# Sito della Rete UdR 11

Sito con mappa interattiva e quadri orari della rete (Air Campania), generato dal GTFS. È un unico file HTML
autonomo (la libreria delle mappe Leaflet è inclusa): si apre con un doppio clic o si pubblica così com'è.
Grafica e funzioni sono le stesse dei siti delle altre UdR (base: UdR 5).

## Funzioni

- **Elenco linee per comune** (il comune indicato in `route_desc` del GTFS) con ricerca per linea o fermata e numero
  di corse nel giorno scelto. Il numero della linea si mostra senza la sigla del comune (`B_Fr` → **B**).
- **Giorno**: si sceglie una data; linee, corse e partenze seguono i calendari.
- **Calendari**: quelli del GTFS (`calendar.txt`), con le eccezioni di `calendar_dates.txt` (nessuna corsa
  scolastica feriale l'8/12 e il 25/12). Le etichette mostrate sono impostate in `ETICHETTE` in testa a `build_data.py`:
  - `udr11_L1_SCLFER` *Scolastico feriale*: dal lunedì al venerdì;
  - `udr11_L2_SCLPREF` *Scolastico sabato*;
  - `udr11_L3_SCLFEST` *Scolastico festivo*: la domenica;
  - `udr11_L4_Giovedi_Formia` *Giovedì*: corse del giovedì della linea B di Formia.
- **Mappa** (sfondi Esri: stradale, topografica, grigio chiaro, satellite): percorsi della linea con frecce del
  senso di marcia, capolinea P/A, varianti di percorso evidenziabili, filtro per zone, schermo intero, stampa.
- **Quadro orario** per calendario e direzione, con fermate principali o tutte; clic su una corsa per vederla
  sulla mappa, clic su una fermata per le sue partenze del giorno.
- **Vicino a me** e **Bus in viaggio** (posizioni stimate dagli orari programmati, non in tempo reale).
- Orari sempre nel formato **hh:mm**: gli orari del GTFS con i secondi sono troncati al minuto.

**Correzioni ai nomi**: errori nei nomi delle linee e nelle destinazioni delle corse del GTFS si correggono in
`CORREZIONI` in testa a `build_data.py` (es. linea A di Spigno Saturnia: «Via Pellizzari» → «Via Pezzellari»);
valgono anche per i GTFS caricati in seguito.

**Fermate principali**: sono quelle che il GTFS indica con orario garantito (`timepoint` = 1), più i capolinea.
Se un GTFS futuro non le distinguesse, lo script usa le regole delle altre UdR (prima fermata in ogni comune,
nodi serviti da almeno 4 altre linee, una fermata almeno ogni 5 minuti di viaggio).

**Nomi delle fermate**: il GTFS li scrive in più modi (`MINTURNO | Via Appia # f4555`,
`FORMIA  Via Vitruvio  f4336 04023 Formia LT Italia`, `Via dei Platani, 165, 04023 Formia LT, Italia`,
`EUROPA/LUCANI`). Dal nome si tolgono il codice (`# f4555`, `f4336`) e la parte di indirizzo (CAP, provincia,
«Italia»); i nomi tutti in maiuscolo diventano «Iniziali Maiuscole»; il comune o la frazione si mostra sotto il nome.
Le fermate della rete urbana di Terracina (codice `TE_…`) sono assegnate a Terracina; le altre il cui nome non
indica il comune prendono quello della fermata più vicina (entro 3 km). Grafie dei comuni e frazioni sono in testa a
`build_data.py` (`LOCALITA`, `NOMI_COMUNI`, `FRAZIONI`, `COMUNE_DA_CODICE`).

## File

- `template.html`: grafica e funzioni del sito, con i segnaposto per i dati.
- `logo.png`: logo Astral Infomobilità al centro della testata (incluso nella pagina; per cambiarlo basta
  sostituire il file).
- `build_data.py`: legge il GTFS e scrive il sito completo in `sito-mappe/index.html` (pubblicato online) e
  `index.html` nella radice del repo.

Online (GitHub Pages) viene pubblicato **solo** `index.html`: script, modello, README e file GTFS restano nel
repository e non sono raggiungibili dall'indirizzo del sito. La pagina non mostra il nome del file GTFS.

## Pubblicazione (la prima volta)

In *Settings → Pages*, alla voce *Build and deployment → Source* scegliere **GitHub Actions**. Poi in *Actions*
aprire *Pubblica sito mappe* e premere *Run workflow* (oppure basta il prossimo commit su `main`).
L'indirizzo del sito sarà https://astral-spa.github.io/UDR11/

## Aggiornare con un nuovo GTFS

**Da GitHub**: *Add file → Upload files*, trascina il nuovo zip GTFS e fai *Commit changes* su `main`.
Il workflow *Pubblica sito mappe* rigenera e ripubblica il sito in un paio di minuti (scheda *Actions*).

**Un nuovo GTFS si può caricare in anticipo.** Il sito usa tutti gli zip presenti nella radice del repo: ogni GTFS
sostituisce il precedente a partire dalla data di avvio del suo calendario (la `start_date` più bassa di
`calendar.txt`). Scegliendo un giorno prima di quella data si vede l'orario precedente, da quella data in poi
quello nuovo; la pagina passa da sola all'orario giusto quando si cambia giorno. Se due zip hanno la stessa data
di avvio vale quello caricato per ultimo. I vecchi zip si possono cancellare quando il loro periodo è passato.

Senza argomento lo script usa tutti gli zip della radice; con un percorso usa solo quel GTFS.

**Dal computer** (serve solo Python 3):

```bash
python3 sito-mappe/build_data.py [percorso/GTFS.zip]
```
