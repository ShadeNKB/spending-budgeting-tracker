import { preview } from "vite";

const port = Number(process.env.SMOKE_PORT ?? 4173);
const baseUrl = `http://127.0.0.1:${port}`;
const routes = ["/", "/pulse", "/ledger", "/insights"];

const server = await preview({
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
});

async function assertOk(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (response.status !== 200) {
    throw new Error(`${path} returned ${response.status}`);
  }
  const html = await response.text();
  if (!html.includes("SpendTrack")) {
    throw new Error(`${path} HTML missing SpendTrack title`);
  }
  console.log(`OK: ${path} -> 200`);
}

async function assertAsset(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  console.log(`OK: ${path}`);
}

try {
  for (const route of routes) {
    await assertOk(route);
  }
  await assertAsset("/sw.js");
  await assertAsset("/manifest.webmanifest");
} finally {
  await new Promise((resolve, reject) => {
    server.httpServer.close((err) => (err ? reject(err) : resolve(undefined)));
  });
}
