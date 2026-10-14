#!/usr/bin/env node
// Runs after job/scripts/refresh-data.mjs in the scheduled job (and by hand).
// Copies the refreshed dataset into data/, signs it when a signing key is set,
// and always writes data/status.json: when the job last ran and what each
// source did. That file changes every run, which also keeps GitHub from
// pausing the schedule (it pauses after 60 days without repository activity).
//
//   CRIMESTATS_SIGNING_KEY  PEM private key (ECDSA P-256). Optional: unsigned
//                           data is still usable, and apps label it with its
//                           own address as a custom source.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { sign, createPrivateKey } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fresh = join(ROOT, 'job', 'crimestats-data.json');   // written by refresh-data.mjs this run
const out = join(ROOT, 'data');
mkdirSync(out, { recursive: true });
const pem = (process.env.CRIMESTATS_SIGNING_KEY || '').trim();

let published = false;
if (existsSync(fresh)) {
  const bytes = readFileSync(fresh);
  writeFileSync(join(out, 'crimestats-data.json'), bytes);
  if (pem) {
    const sig = sign('sha256', bytes, { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
    writeFileSync(join(out, 'crimestats-data.json.sig'), sig.toString('base64') + '\n');
  } else rmSync(join(out, 'crimestats-data.json.sig'), { force: true });
  published = true;
}
const current = existsSync(join(out, 'crimestats-data.json')) ? JSON.parse(readFileSync(join(out, 'crimestats-data.json'), 'utf8')) : null;
writeFileSync(join(out, 'status.json'), JSON.stringify({
  lastRun: new Date().toISOString(),
  publishedThisRun: published,
  signed: existsSync(join(out, 'crimestats-data.json.sig')),
  dataUpdated: current?.meta?.updated ?? null,
  generation: current?.meta?.generation ?? null,
  sources: current?.meta?.sourceStatus ?? {}
}, null, 2) + '\n');
console.log(published ? `published data/crimestats-data.json (${pem ? 'signed' : 'unsigned'})` : 'refresh wrote nothing new; data/ unchanged, status updated');
