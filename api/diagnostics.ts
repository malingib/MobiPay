export default async function handler(_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  try {
    await import("../apps/api/src/app.js");
    res.status(200).json({ ok: true, module: "loaded" });
  } catch (error) {
    const value = error as { name?: string; message?: string; code?: string };
    res.status(500).json({ ok: false, name: value.name ?? "Error", code: value.code ?? null, message: value.message ?? "module initialization failed" });
  }
}
