# Walkwise

Walkwise ist ein Web-MVP fuer schoene Walking-Routen durch Staedte. Nutzer waehlen eine Stadt, bekommen beliebte Sehenswuerdigkeiten aus offenen Daten vorgeschlagen und planen daraus eine Tagesroute zu Fuss.

## Lokal starten

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Frontend: http://127.0.0.1:5173  
Backend: http://127.0.0.1:8010

## Tests und Build

```bash
npm test
npm run build
```

## Deployment

Das Projekt ist fuer Vercel vorbereitet. `vercel.json` baut das React-Frontend aus `frontend/dist` und stellt das Express-Backend als Vercel Function unter `/api` bereit.

Optional kann in Vercel die Environment Variable `OPEN_DATA_USER_AGENT` gesetzt werden, z. B. mit Kontakt- oder Projekt-URL fuer OpenStreetMap/Nominatim/Wikidata-Requests.
