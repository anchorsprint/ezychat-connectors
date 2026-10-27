import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { build, collect, iconProblem, ROOT, sequenceFrom, sha256 } from './build.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16"/></svg>\n';

const MCP = `id: partner-test
schemaVersion: 1
minAppVersion: 0.1.62
kind: mcp
editions: [lite, enterprise]
name: Partner Test
summary:
  en: Looks up orders.
description:
  en: The AI looks up an order by number.
category: other
publisher: Partner Sdn Bhd
privacy:
  en: Order numbers go between your computer and Partner.
mcp:
  url: https://{tenant}.partner.example/mcp
auth:
  type: credentials
  fields:
    - id: tenant
      label: { en: Tenant }
      secret: false
    - id: key
      label: { en: Key }
      secret: true
  headers:
    - name: Authorization
      value: Bearer {key}
settings:
  - id: hours
    type: timeRange
    label: { en: Hours }
tools:
  - name: find_order
    title: { en: Find an order }
    description: { en: Finds an order by number. }
    access: read
  - name: add_note
    title: { en: Add a note }
    description: { en: Adds a note to the order. }
    access: write
    guards:
      confirmFirst: true
      valueFrom: { order: find_order }
      within: { start: hours }
icon: icon.svg
`;

const SOON = `id: soon-one
schemaVersion: 1
minAppVersion: 0.1.0
kind: coming_soon
editions: [lite, enterprise]
name: Soon One
summary: { en: Soon. }
description: { en: Coming soon. }
category: crm
vote: { en: Please add Soon One. }
`;

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

/** A temp repo with the real schema and the given connector folders. */
function repo(folders) {
  root = mkdtempSync(join(tmpdir(), 'connectors-'));
  cpSync(join(ROOT, 'schema'), join(root, 'schema'), { recursive: true });
  for (const [id, files] of Object.entries(folders)) {
    mkdirSync(join(root, 'connectors', id), { recursive: true });
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(root, 'connectors', id, name), text);
  }
  return root;
}

describe('build', () => {
  it('builds and signs a good folder; the signature verifies with the public key', () => {
    const r = repo({
      'partner-test': { 'connector.yaml': MCP, 'icon.svg': SVG, 'skill.md': '# Orders\nAsk for the number.\n', 'skill.ms.md': 'Minta nombor.' },
      'soon-one': { 'connector.yaml': SOON },
    });
    writeFileSync(join(r, 'order.yaml'), 'order: [soon-one]\n');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const result = build({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem, LIST_SEQUENCE: '42' } });
    assert.equal(result.ok, true, result.problems.join('\n'));
    const bytes = readFileSync(join(r, 'dist', 'list-v1.json'));
    const sig = Buffer.from(readFileSync(join(r, 'dist', 'list-v1.json.sig'), 'utf8').trim(), 'base64');
    assert.equal(verify(null, bytes, publicKey, sig), true);
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    assert.equal(result.publicKey, raw);
    // The raw key alone (as the app holds it) verifies too.
    const appKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    assert.equal(verify(null, bytes, appKey, sig), true);

    const list = JSON.parse(bytes.toString('utf8'));
    assert.equal(list.format, 1);
    assert.equal(list.sequence, 42);
    assert.ok(!Number.isNaN(Date.parse(list.generatedAt)));
    assert.deepEqual(list.entries.map((e) => e.id), ['soon-one', 'partner-test']);
    const partner = list.entries[1];
    assert.deepEqual(partner.icon, { file: 'partner-test.svg', sha256: sha256(Buffer.from(SVG)), size: Buffer.byteLength(SVG) });
    assert.deepEqual(partner.skill, { en: '# Orders\nAsk for the number.', ms: 'Minta nombor.' });
    assert.equal(readFileSync(join(r, 'dist', 'icons', 'partner-test.svg'), 'utf8'), SVG);
  });

  it('--check needs no key and writes nothing', () => {
    const r = repo({ 'soon-one': { 'connector.yaml': SOON } });
    const result = build({ root: r, check: true, env: {} });
    assert.equal(result.ok, true);
    assert.throws(() => readFileSync(join(r, 'dist', 'list-v1.json')));
    assert.deepEqual(build({ root: r, env: {} }).problems, ['CONNECTOR_LIST_SIGNING_KEY is not set']);
  });

  it('refuses a non-Ed25519 signing key and a bad sequence', () => {
    const r = repo({ 'soon-one': { 'connector.yaml': SOON } });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    assert.throws(() => build({ root: r, env: { CONNECTOR_LIST_SIGNING_KEY: pem } }), /Ed25519/);
    assert.throws(() => sequenceFrom({ LIST_SEQUENCE: '0' }), /positive/);
    assert.throws(() => sequenceFrom({ LIST_SEQUENCE: '-3' }), /positive/);
    assert.equal(sequenceFrom({}, 1_700_000_000_999), 1_700_000_000);
  });

  const cases = [
    ['an id other than the folder name', { 'other-id': { 'connector.yaml': SOON } }, /id must equal the folder name/],
    ['a bad folder name', { Bad_Name: { 'connector.yaml': SOON } }, /folder name must be a connector id/],
    ['a missing connector.yaml', { 'soon-one': { 'readme.txt': 'x' } }, /connector.yaml is missing/],
    ['broken YAML', { 'soon-one': { 'connector.yaml': 'id: [' } }, /not valid YAML/],
    ['YAML aliases', { 'soon-one': { 'connector.yaml': `${SOON}publisher: &a x\nhomepage: *a\n` } }, /not valid YAML/],
    ['an unknown field', { 'soon-one': { 'connector.yaml': `${SOON}colour: red\n` } }, /must NOT have additional properties \(colour\)/],
    ['a wrong schema version', { 'soon-one': { 'connector.yaml': SOON.replace('schemaVersion: 1', 'schemaVersion: 2') } }, /schemaVersion must be equal to constant/],
    ['an http MCP address', { 'partner-test': { 'connector.yaml': MCP.replace('https://{tenant}', 'http://{tenant}'), 'icon.svg': SVG } }, /mcp.url must be an https address/],
    ['a secret-like field', { 'partner-test': { 'connector.yaml': MCP.replace('  type: credentials', '  clientSecret: abc\n  type: credentials'), 'icon.svg': SVG } }, /auth.clientSecret looks like a secret/],
    ['a token field', { 'soon-one': { 'connector.yaml': `${SOON}accessToken: abc\n` } }, /accessToken looks like a secret/],
    ['a skill that is too long', { 'soon-one': { 'connector.yaml': SOON, 'skill.md': 'x'.repeat(6001) } }, /skill.md has 6001 characters/],
    ['a translated skill without English', { 'soon-one': { 'connector.yaml': SOON, 'skill.zh-CN.md': '你好' } }, /skill.md \(English\) is needed/],
    ['a skill in two places', { 'soon-one': { 'connector.yaml': `${SOON}skill: { en: Hi }\n`, 'skill.md': 'Hi' } }, /not both/],
    ['an mcp entry without tools', { 'partner-test': { 'connector.yaml': MCP.slice(0, MCP.indexOf('tools:')) + 'icon: icon.svg\n', 'icon.svg': SVG } }, /mcp entries need mcp, auth and tools/],
    ['a builtin entry without builtinId', { 'soon-one': { 'connector.yaml': SOON.replace('kind: coming_soon', 'kind: builtin') } }, /builtin entries need builtinId/],
    ['valueFrom to a write tool', { 'partner-test': { 'connector.yaml': MCP.replace('order: find_order', 'order: add_note'), 'icon.svg': SVG } }, /valueFrom add_note must be a read tool/],
    ['within to an unknown setting', { 'partner-test': { 'connector.yaml': MCP.replace('start: hours', 'start: days'), 'icon.svg': SVG } }, /within days must be a setting/],
    ['a missing icon file', { 'partner-test': { 'connector.yaml': MCP } }, /icon.svg is missing/],
    ['another icon name', { 'partner-test': { 'connector.yaml': MCP.replace('icon: icon.svg', 'icon: logo.svg'), 'logo.svg': SVG } }, /icon must be icon.svg or icon.png/],
    ['a script in the icon', { 'partner-test': { 'connector.yaml': MCP, 'icon.svg': '<svg><script>x()</script></svg>' } }, /must not contain <script>/],
    ['an unknown id in order.yaml', { 'soon-one': { 'connector.yaml': SOON } }, /order.yaml: unknown connector nope/, 'order: [nope]\n'],
  ];
  for (const [name, folders, expected, order] of cases)
    it(`rejects ${name}`, () => {
      const r = repo(folders);
      if (order) writeFileSync(join(r, 'order.yaml'), order);
      const result = build({ root: r, check: true });
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), expected);
    });

  it('allows `secret: true|false` of a credentials field only', () => {
    const r = repo({ 'partner-test': { 'connector.yaml': MCP, 'icon.svg': SVG } });
    assert.deepEqual(build({ root: r, check: true }).problems, []);
  });

  it('checks icons as the app does', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
    assert.equal(iconProblem('icon.png', png), null);
    assert.match(iconProblem('icon.png', Buffer.from(SVG)), /not a PNG/);
    assert.match(iconProblem('icon.svg', png), /not an SVG/);
    assert.match(iconProblem('icon.svg', Buffer.from('<svg onload="x()"/>')), /event handler/);
    assert.match(iconProblem('icon.svg', Buffer.from('<svg><a href="javascript:x()"/></svg>')), /javascript/);
    assert.match(iconProblem('icon.svg', Buffer.alloc(0)), /must be 1 byte/);
  });

  it('the connectors in this repository are valid', () => {
    const result = collect();
    assert.deepEqual(result.problems, []);
    assert.equal(result.entries[0].id, 'google-calendar');
    for (const entry of result.entries) assert.ok(entry.icon?.sha256, `${entry.id} has an icon`);
  });
});

