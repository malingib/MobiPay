// Vercel catch-all function for the Express API. The app module exports an Express
// application without opening a listening socket, so Vercel owns the request lifecycle.
export { default } from "../apps/api/src/app.js";
