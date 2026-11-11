// /api/tex/*: TeX status and package management.
import express from 'express';
import {
  installedPackages, installPackages, packagesProviding, removePackages, resetUserLayer,
  searchPackages, setTexMode, texStatus, updateAll,
} from './tex.ts';

export function texRoutes(): express.Router {
  const r = express.Router();
  const wrap = (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler => (req, res) => {
    fn(req).then((v) => res.json(v ?? { ok: true }), (e) => res.status(400).json({ error: String(e?.message ?? e) }));
  };
  const names = (req: express.Request) => (Array.isArray(req.body?.packages) ? req.body.packages.map(String) : []);

  r.get('/status', wrap(() => texStatus()));
  r.post('/mode', wrap(async (req) => { await setTexMode(req.body?.mode === 'system' ? 'system' : 'bundled'); return texStatus(); }));
  r.get('/packages', wrap(async () => ({ packages: await installedPackages() })));
  r.get('/search', wrap(async (req) => ({ packages: await searchPackages(String(req.query.q ?? '')) })));
  r.get('/provides', wrap(async (req) => ({ packages: await packagesProviding(String(req.query.file ?? '')) })));
  r.post('/install', wrap(async (req) => ({ output: await installPackages(names(req)) })));
  r.post('/remove', wrap(async (req) => ({ output: await removePackages(names(req)) })));
  r.post('/update', wrap(async () => ({ output: await updateAll() })));
  r.post('/reset', wrap(async () => { await resetUserLayer(); return { ok: true }; }));
  return r;
}
