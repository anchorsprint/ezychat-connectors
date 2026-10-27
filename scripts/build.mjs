#!/usr/bin/env node
// Builds the EzyChat connector list from the connector folders.
//
//   node scripts/build.mjs --check     validate every connector (no key needed; CI on pull requests)
//   node scripts/build.mjs             validate, then write dist/list-v1.json, dist/icons/ and
//                                      dist/list-v1.json.sig (signed with the Ed25519 PEM private key
//                                      in CONNECTOR_LIST_SIGNING_KEY; LIST_SEQUENCE overrides the
//                                      sequence, default: seconds since 1970)
//
// The app downloads list-v1.json and list-v1.json.sig from https://dl.ezychat.ai/connectors/,
// verifies the signature of the exact bytes with the public keys built into the app, refuses a
// lower sequence and checks the SHA-256 and size of every icon. See README.md.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIST_FORMAT = 1;
export const SKILL_MAX = 6000;
export const ICON_MAX = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const LANGUAGES = { en: 'skill.md', ms: 'skill.ms.md', 'zh-CN': 'skill.zh-CN.md' };
/** Field names that suggest a secret. The list is public: a secret never goes in it. */
const SECRET_NAME = /secret|passw(or)?d|token|api[-_]?key|private[-_]?key|credential[-_]?value/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The same icon rule as the app: a PNG, or an SVG that can run nothing. */
export function iconProblem(file, bytes) {
  if (bytes.length === 0 || bytes.length > ICON_MAX) return `must be 1 byte to ${ICON_MAX} bytes`;
  if (file.endsWith('.png'))
    return bytes.subarray(0, 8).equals(PNG_MAGIC) ? null : 'is not a PNG file';
  const text = bytes.toString('utf8');
  if (bytes.subarray(0, 8).equals(PNG_MAGIC) || !/<svg[\s>]/i.test(text)) return 'is not an SVG file';
  if (/<script/i.test(text)) return 'must not contain <script>';
  if (/[\s"'/]on[a-z]+\s*=/i.test(text)) return 'must not contain event handler attributes (on…=)';
  if (/javascript\s*:/i.test(text)) return 'must not contain javascript: links';
  return null;
}

/** Paths of keys named like a secret. `secret: true|false` of a credentials field is allowed. */
function secretFields(value, path = []) {
  if (Array.isArray(value)) return value.flatMap((item, i) => secretFields(item, [...path, i]));
  if (!value || typeof value !== 'object') return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...path, key];
    const credentialFlag =
      key === 'secret' &&
      typeof child === 'boolean' &&
      path.length === 3 &&
      path[0] === 'auth' &&
      path[1] === 'fields';
    if (SECRET_NAME.test(key) && !credentialFlag) found.push(here.join('.'));
    found.push(...secretFields(child, here));
  }
  return found;
}

const httpsUrl = (value) => {
  try {
    return new URL(String(value).replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, 'x')).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The cross-field rules of the app contract (its zod superRefine) plus the https address. */
export function semanticProblems(entry) {
  const problems = [];
  if (entry.kind === 'mcp' && (!entry.mcp || !entry.auth || !entry.tools?.length))
    problems.push('mcp entries need mcp, auth and tools');
  if (entry.kind === 'builtin' && !entry.builtinId) problems.push('builtin entries need builtinId');
  if (entry.mcp && !httpsUrl(entry.mcp.url)) problems.push('mcp.url must be an https address');
  const tools = entry.tools ?? [];
  const settings = new Set((entry.settings ?? []).map((s) => s.id));
  for (const tool of tools) {
    for (const from of Object.values(tool.guards?.valueFrom ?? {}))
      if (tools.find((t) => t.name === from)?.access !== 'read')
        problems.push(`tool ${tool.name}: valueFrom ${from} must be a read tool`);
    for (const setting of Object.values(tool.guards?.within ?? {}))
      if (!settings.has(setting))
        problems.push(`tool ${tool.name}: within ${setting} must be a setting`);
  }
  return problems;
}

export function loadValidator(schemaPath = join(ROOT, 'schema', 'connector-v1.json')) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
}

/**
 * Reads every connectors/<id>/ folder. Returns the entries (icons replaced by {file, sha256, size},
 * skills inlined), the icon files by published name, and every problem found.
 */
export function collect(root = ROOT, validate = loadValidator()) {
  const problems = [];
  const entries = [];
  const icons = new Map();
  const dir = join(root, 'connectors');
  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  const seen = new Set();
  for (const folder of folders) {
    const at = `connectors/${folder}`;
    const report = (message) => problems.push(`${at}: ${message}`);
    if (!ID.test(folder)) {
      report('folder name must be a connector id (a-z, 0-9 and -, 2 to 49 characters)');
      continue;
    }
    const yamlPath = join(dir, folder, 'connector.yaml');
    if (!existsSync(yamlPath)) {
      report('connector.yaml is missing');
      continue;
    }
    let entry;
    try {
      entry = parseYaml(readFileSync(yamlPath, 'utf8'), { maxAliasCount: 0, uniqueKeys: true });
    } catch (err) {
      report(`connector.yaml is not valid YAML (${err.message.split('\n')[0]})`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      report('connector.yaml must be a mapping');
      continue;
    }
    for (const path of secretFields(entry))
      report(`field ${path} looks like a secret: the list is public, never put a secret in it`);
    if (entry.id !== folder) report(`id must equal the folder name (${folder})`);
    if (seen.has(entry.id)) report(`id ${entry.id} is used twice`);
    seen.add(entry.id);

    // Skills: skill.md (English) and optional translations, inlined as `skill`.
    const skill = {};
    for (const [language, file] of Object.entries(LANGUAGES)) {
      const path = join(dir, folder, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > SKILL_MAX) report(`${file} has ${text.length} characters (at most ${SKILL_MAX})`);
      if (text) skill[language] = text;
    }
    if (Object.keys(skill).length) {
      if (entry.skill !== undefined) report('write the skill in skill.md or connector.yaml, not both');
      else if (!skill.en) report('skill.md (English) is needed when a translated skill exists');
      else entry.skill = skill;
    }

    // Icon: `icon: icon.svg` (or icon.png) in the folder; published as icons/<id>.<ext>.
    if (entry.icon !== undefined) {
      const name = entry.icon;
      if (name !== 'icon.svg' && name !== 'icon.png') report('icon must be icon.svg or icon.png');
      else if (!existsSync(join(dir, folder, name))) report(`${name} is missing`);
      else {
        const bytes = readFileSync(join(dir, folder, name));
        const problem = iconProblem(name, bytes);
        if (problem) report(`${name} ${problem}`);
        const file = `${folder}.${name.split('.').pop()}`;
        entry.icon = { file, sha256: sha256(bytes), size: bytes.length };
        icons.set(file, bytes);
      }
    }

    if (!validate(entry))
      for (const error of validate.errors ?? [])
        report(`${error.instancePath || '/'} ${error.message}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`);
    for (const problem of semanticProblems(entry)) report(problem);
    entries.push(entry);
  }

  // Gallery order: the ids in order.yaml first, every other connector after them by id.
  let order = [];
  const orderPath = join(root, 'order.yaml');
  if (existsSync(orderPath)) {
    order = parseYaml(readFileSync(orderPath, 'utf8'))?.order ?? [];
    for (const id of order) if (!seen.has(id)) problems.push(`order.yaml: unknown connector ${id}`);
  }
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  entries.sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)));
  return { entries, icons, problems };
}

export function sequenceFrom(env = process.env, now = Date.now()) {
  const text = env.LIST_SEQUENCE;
  if (text === undefined || text === '') return Math.floor(now / 1000);
  if (!/^[1-9]\d{0,15}$/.test(text)) throw new Error('LIST_SEQUENCE must be a positive integer');
  return Number(text);
}

/** The exact list bytes the app verifies. */
export function listBytes(entries, sequence, generatedAt = new Date().toISOString()) {
  return Buffer.from(
    `${JSON.stringify({ format: LIST_FORMAT, generatedAt, sequence, entries }, null, 2)}\n`,
  );
}

/** Base64 Ed25519 signature of `bytes` and the signer's raw public key (to compare with the app). */
export function signList(bytes, pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    signature: sign(null, bytes, key).toString('base64'),
    publicKey: publicKey.toString('base64'),
  };
}

export function build({ root = ROOT, check = false, env = process.env, out = join(root, 'dist') } = {}) {
  const { entries, icons, problems } = collect(root);
  if (problems.length) return { ok: false, problems, entries };
  if (check) return { ok: true, problems, entries };
  const pem = env.CONNECTOR_LIST_SIGNING_KEY;
  if (!pem) return { ok: false, problems: ['CONNECTOR_LIST_SIGNING_KEY is not set'], entries };
  const sequence = sequenceFrom(env);
  const bytes = listBytes(entries, sequence);
  const { signature, publicKey } = signList(bytes, pem);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });
  for (const [file, data] of icons) writeFileSync(join(out, 'icons', file), data);
  writeFileSync(join(out, 'list-v1.json'), bytes);
  writeFileSync(join(out, 'list-v1.json.sig'), `${signature}\n`);
  return { ok: true, problems, entries, sequence, publicKey, icons: icons.size, bytes: bytes.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv.includes('--check');
  const result = build({ check });
  if (!result.ok) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    console.error(`${result.problems.length} problem(s); nothing was built.`);
    process.exit(1);
  }
  const kinds = result.entries.reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {});
  console.log(`✓ ${result.entries.length} connectors valid ${JSON.stringify(kinds)}`);
  if (!check)
    console.log(
      `✓ dist/list-v1.json: sequence ${result.sequence}, ${result.bytes} bytes, ${result.icons} icons, signed by ${result.publicKey}`,
    );
}
