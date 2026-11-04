import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { build, collect, ROOT, SIGNING_CONTEXT } from './build-templates.mjs';

const CATEGORIES = [{ id: 'food', name: { en: 'Food', ms: 'Makanan' } }];

const META = {
  id: 'noodleShop',
  version: 1,
  schemaVersion: 1,
  minAppVersion: '0.1.75',
  editions: ['lite', 'enterprise'],
  category: 'food',
  icon: 'utensils',
  preset: 'sales',
  texts: {
    en: {
      agentName: 'Noodle assistant',
      name: 'Noodle shop',
      description: 'Answers about the menu and opening hours.',
      keywords: 'noodle menu',
      contextName: 'Shop details',
    },
  },
};

const LONG = { 'focus.md': 'Help customers order.\n', 'handoff-rules.md': 'Hand over complaints.\n', 'context.md': 'Open 9am to 9pm.\n' };

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

/** A temp repo with the real schema, categories and the given template folders. */
function repo(templates, categories = CATEGORIES) {
  root = mkdtempSync(join(tmpdir(), 'templates-'));
  cpSync(join(ROOT, 'schema'), join(root, 'schema'), { recursive: true });
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(join(root, 'templates', 'categories.json'), JSON.stringify(categories));
  for (const [folder, { meta, langs = { en: LONG } }] of Object.entries(templates)) {
    mkdirSync(join(root, 'templates', folder), { recursive: true });
    writeFileSync(join(root, 'templates', folder, 'template.json'), JSON.stringify(meta, null, 2));
    for (const [lang, files] of Object.entries(langs)) {
      mkdirSync(join(root, 'templates', folder, lang), { recursive: true });
      for (const [name, text] of Object.entries(files))
        writeFileSync(join(root, 'templates', folder, lang, name), text);
    }
  }
  return root;
}

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey };
};

/** The public key as the app holds it: the raw 32 bytes, wrapped in the Ed25519 SPKI prefix. */
const appKey = (raw) =>
  createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64')]),
    format: 'der',
    type: 'spki',
  });

describe('build-templates', () => {
  it('builds and signs a good folder with sequence 1 when nothing is published', () => {
    const r = repo({ noodleShop: { meta: META } });
    const { pem } = keyPair();
    const result = build({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem }, published: null });
    assert.equal(result.ok, true, result.problems.join('\n'));
    assert.equal(result.changed, true);
    const list = JSON.parse(readFileSync(join(r, 'dist', 'templates', 'templates-v1.json'), 'utf8'));
    assert.equal(list.format, 1);
    assert.equal(list.catalog, 'templates');
    assert.equal(list.sequence, 1);
    assert.ok(!Number.isNaN(Date.parse(list.generatedAt)));
    assert.deepEqual(list.categories, CATEGORIES);
    assert.deepEqual(list.entries[0].texts.en, {
      ...META.texts.en,
      focus: 'Help customers order.',
      handoffRules: 'Hand over complaints.',
      contextText: 'Open 9am to 9pm.',
    });
  });

  it('signs over the template prefix: it verifies as a template list, never as a connector list', () => {
    const r = repo({ noodleShop: { meta: META } });
    const { pem, publicKey } = keyPair();
    const result = build({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem }, published: null });
    assert.equal(result.ok, true, result.problems.join('\n'));
    const bytes = readFileSync(join(r, 'dist', 'templates', 'templates-v1.json'));
    const sigText = readFileSync(join(r, 'dist', 'templates', 'templates-v1.json.sig'), 'utf8');
    assert.match(sigText, /^[A-Za-z0-9+/]+={0,2}\n$/);
    const sig = Buffer.from(sigText.trim(), 'base64');
    assert.equal(sig.length, 64);
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    assert.equal(result.publicKey, raw);
    const key = appKey(raw);
    const prefixed = Buffer.concat([Buffer.from(SIGNING_CONTEXT, 'utf8'), bytes]);
    assert.equal(SIGNING_CONTEXT, 'ezychat-templates-v1\n');
    assert.equal(verify(null, prefixed, key, sig), true);
    // The connector list check (signature over the bare bytes) refuses it.
    assert.equal(verify(null, bytes, key, sig), false);
    // And a signature over bare bytes (a connector list signature) fails the template check.
    const other = keyPair();
    assert.equal(verify(null, prefixed, other.publicKey, sig), false);
  });

  it('a connector list signature never verifies as a template list', async () => {
    const { build: buildConnectors } = await import('./build.mjs');
    const r = mkdtempSync(join(tmpdir(), 'connectors-'));
    try {
      cpSync(join(ROOT, 'schema'), join(r, 'schema'), { recursive: true });
      cpSync(join(ROOT, 'connectors'), join(r, 'connectors'), { recursive: true });
      const { pem, publicKey } = keyPair();
      const result = buildConnectors({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem, LIST_SEQUENCE: '7' } });
      assert.equal(result.ok, true, result.problems.join('\n'));
      const bytes = readFileSync(join(r, 'dist', 'list-v1.json'));
      const sig = Buffer.from(readFileSync(join(r, 'dist', 'list-v1.json.sig'), 'utf8').trim(), 'base64');
      assert.equal(verify(null, bytes, publicKey, sig), true);
      const asTemplate = Buffer.concat([Buffer.from(SIGNING_CONTEXT, 'utf8'), bytes]);
      assert.equal(verify(null, asTemplate, publicKey, sig), false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('next sequence = published + 1; unchanged content publishes nothing', () => {
    const r = repo({ noodleShop: { meta: META } });
    const { pem } = keyPair();
    const env = { CONNECTOR_LIST_SIGNING_KEY: pem };
    const out = join(r, 'dist', 'templates', 'templates-v1.json');
    assert.equal(build({ root: r, env, published: null }).sequence, 1);
    const first = readFileSync(out);

    const same = build({ root: r, env, published: first });
    assert.equal(same.ok, true);
    assert.equal(same.changed, false);
    assert.equal(same.sequence, 1);
    assert.equal(existsSync(out), false, 'nothing to upload');

    const published = Buffer.from(JSON.stringify({ ...JSON.parse(first), sequence: 41 }));
    writeFileSync(join(r, 'templates', 'noodleShop', 'en', 'context.md'), 'Open 10am to 10pm.\n');
    const next = build({ root: r, env, published });
    assert.equal(next.changed, true);
    assert.equal(next.sequence, 42);
    assert.equal(JSON.parse(readFileSync(out)).sequence, 42);
  });

  it('refuses a published file that is not a template list (never resets the sequence)', () => {
    const r = repo({ noodleShop: { meta: META } });
    const { pem } = keyPair();
    const env = { CONNECTOR_LIST_SIGNING_KEY: pem };
    assert.throws(() => build({ root: r, env, published: Buffer.from('<html>error</html>') }), /not JSON/);
    assert.throws(() => build({ root: r, env, published: Buffer.from('{"format":1,"sequence":5,"entries":[]}') }), /not a template list/);
    assert.throws(() => build({ root: r, env, published: Buffer.from('{"catalog":"templates","sequence":0}') }), /not a template list/);
  });

  it('--check needs no key and writes nothing; a build without the key fails clearly', () => {
    const r = repo({ noodleShop: { meta: META } });
    const result = build({ root: r, check: true, env: {} });
    assert.equal(result.ok, true, result.problems.join('\n'));
    assert.equal(existsSync(join(r, 'dist')), false);
    assert.deepEqual(build({ root: r, env: {}, published: null }).problems, ['CONNECTOR_LIST_SIGNING_KEY is not set']);
  });

  it('refuses a non-Ed25519 signing key', () => {
    const r = repo({ noodleShop: { meta: META } });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    assert.throws(() => build({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem }, published: null }), /Ed25519/);
  });

  const withText = (lang, field, value) => ({
    ...META,
    texts: { ...META.texts, [lang]: { ...META.texts.en, ...META.texts[lang], [field]: value } },
  });
  const cases = [
    ['an unknown field (schema)', { noodleShop: { meta: { ...META, colour: 'red' } } }, /must NOT have additional properties \(colour\)/],
    ['a wrong schema version (schema)', { noodleShop: { meta: { ...META, schemaVersion: 2 } } }, /schemaVersion must be equal to constant/],
    ['an unknown preset (schema)', { noodleShop: { meta: { ...META, preset: 'magic' } } }, /preset must be equal to one of the allowed values/],
    ['a name that is too long (schema)', { noodleShop: { meta: withText('en', 'name', 'x'.repeat(61)) } }, /texts\/en\/name must NOT have more than 60 characters/],
    ['an id other than the folder name', { otherShop: { meta: META } }, /must equal the folder name/],
    ['an unknown category', { noodleShop: { meta: { ...META, category: 'cars' } } }, /category "cars" is not in categories.json/],
    ['a missing English text file', { noodleShop: { meta: META, langs: { en: { 'focus.md': 'x' } } } }, /en\/handoff-rules.md is missing/],
    ['a language folder without its short texts', { noodleShop: { meta: META, langs: { en: LONG, ms: LONG } } }, /ms needs both texts.ms in template.json and the ms\/ folder/],
    ['an unknown language', { noodleShop: { meta: withText('fr', 'name', 'Nouilles') } }, /texts.fr: unknown language/],
    ['a long text in template.json', { noodleShop: { meta: withText('en', 'focus', 'x') } }, /texts.en.focus belongs in en\/focus.md/],
    ['a control character', { noodleShop: { meta: withText('en', 'description', 'Menu\u0007 and hours.') } }, /texts.en.description contains U\+0007/],
    ['a bidi override', { noodleShop: { meta: withText('en', 'name', 'Noodle ‮shop') } }, /texts.en.name contains U\+202E/],
    ['a bidi isolate in a Markdown file', { noodleShop: { meta: META, langs: { en: { ...LONG, 'focus.md': 'Help ⁦customers⁩.\n' } } } }, /texts.en.focus contains U\+2066/],
    ['a byte order mark', { noodleShop: { meta: META, langs: { en: { ...LONG, 'context.md': '﻿Open.\n' } } } }, /texts.en.contextText contains U\+FEFF/],
    ['Windows line ends', { noodleShop: { meta: META, langs: { en: { ...LONG, 'context.md': 'Open.\r\nClosed Sunday.\n' } } } }, /texts.en.contextText contains U\+000D/],
  ];
  for (const [name, templates, expected] of cases)
    it(`rejects ${name}`, () => {
      const r = repo(templates);
      const result = build({ root: r, check: true });
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), expected);
    });

  it('rejects bad categories', () => {
    const r = repo({ noodleShop: { meta: META } }, [
      ...CATEGORIES,
      { id: 'food', name: { en: 'Again' } },
      { id: 'x', name: { en: 'Too short id' } },
      { id: 'events', name: { ms: 'Acara' } },
      { id: 'travel', name: { en: 'Travel‮' } },
    ]);
    const problems = build({ root: r, check: true }).problems.join('\n');
    assert.match(problems, /"food" is listed twice/);
    assert.match(problems, /"x" is not a category id/);
    assert.match(problems, /"events" needs name.en/);
    assert.match(problems, /"travel" name.en contains U\+202E/);
  });

  it('allows tab and newline in texts', () => {
    const r = repo({ noodleShop: { meta: META, langs: { en: { ...LONG, 'context.md': 'Menu:\n\t- Laksa\n' } } } });
    assert.deepEqual(build({ root: r, check: true }).problems, []);
  });

  it('the templates in this repository are valid', () => {
    const result = collect();
    assert.deepEqual(result.problems, []);
    assert.equal(result.entries.length, 18);
    for (const entry of result.entries) assert.ok(entry.texts.en.focus, `${entry.id} has an English focus`);
  });
});
