import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8010);
const app = createApp();

app.listen(port, () => {
  console.log(`Walking backend listening on http://127.0.0.1:${port}`);
});
