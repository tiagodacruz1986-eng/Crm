// Mise en page des documents : logo (formats acceptés, SVG refusé) et réglages nettoyés.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-brand-'));
let B, db;
before(async () => {
  process.env.DATA_DIR = dataDir;
  db = await import('../src/db.js');
  B = await import('../src/branding.js');
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('logo : PNG accepté, SVG et faux fichiers refusés', () => {
  assert.equal(B.logoFile(), null);
  assert.throws(() => B.saveLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /Format non pris en charge/);
  assert.throws(() => B.saveLogo(Buffer.from('GIF89a....')), /Format non pris en charge/);
  assert.throws(() => B.saveLogo(Buffer.alloc(0)), /vide/);
  const layout = B.saveLogo(PNG);
  assert.ok(layout.logo_version);
  assert.equal(B.logoFile().type, 'image/png');
  assert.equal(db.getSettings().layout.logo_version, layout.logo_version);
  // Un nouveau logo JPEG remplace l'ancien PNG
  B.saveLogo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]));
  assert.equal(B.logoFile().type, 'image/jpeg');
  assert.equal(fs.readdirSync(path.join(dataDir, 'branding')).length, 1);
  B.deleteLogo();
  assert.equal(B.logoFile(), null);
  assert.equal(db.getSettings().layout.logo_version, null);
});

test('réglages de mise en page : seules les valeurs valides sont gardées', () => {
  const out = B.cleanLayout({
    template: 'audacieux', font: 'georgia', primary: '#C1121F', secondary: 'red; background:url(x)', paper: 'A5',
    tagline: 'x'.repeat(500), terms: 'Paiement à 15 jours', show_qr: 0, logo_version: 999, hack: true,
  });
  assert.equal(out.template, 'audacieux');
  assert.equal(out.font, 'georgia');
  assert.equal(out.primary, '#c1121f');
  assert.equal(out.secondary, '#0f172a'); // valeur par défaut conservée
  assert.equal(out.paper, 'A4');
  assert.equal(out.tagline.length, 120);
  assert.equal(out.show_qr, false);
  assert.equal(out.logo_version, null); // seul l'envoi d'un logo peut la changer
  assert.equal(out.hack, undefined);
  assert.equal(B.cleanLayout({ template: 'inconnu' }).template, 'moderne');
});
