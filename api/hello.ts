// Minimal test endpoint — geen imports, geen logica.
// Doel: valideren of Vercel's /api/-detectie + TS-runtime werken.
// Als dit ook 500 geeft → project-niveau probleem.
// Als dit 200 geeft → report.ts heeft een specifieke bug.

export default function handler(req: any, res: any) {
  res.status(200).json({ ok: true, msg: 'hello from BannerBye API' });
}
