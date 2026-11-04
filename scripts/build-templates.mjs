#!/usr/bin/env node
// Builds the EzyChat AI agent template list from the template folders.
//
//   node scripts/build-templates.mjs --check
//       validate every template (no key needed; CI on pull requests)
//   node scripts/build-templates.mjs --published <file>|none
//       validate, then write dist/templates/templates-v1.json and templates-v1.json.sig, signed with
//       the Ed25519 PEM private key in CONNECTOR_LIST_SIGNING_KEY (the connector list's key).
//       <file> is the list currently on dl.ezychat.ai (`none` when nothing is published yet): the new
//       sequence is its sequence + 1 (1 when none), and nothing is written when the categories and
//       entries are the same as the published ones (the sequence then stays as it is).
//
// The app downloads templates-v1.json and templates-v1.json.sig from https://dl.ezychat.ai/templates/
// and verifies the signature over SIGNING_CONTEXT followed by the exact file bytes. The connector
// list is signed over its bytes alone, so with the same key neither list can stand in for the other.
// See README.md.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_LIST_FORMAT = 1;
export const SIGNING_CONTEXT = 'ezychat-templates-v1\n';
export const LANGUAGES = ['en', 'ms', 'zh-CN'];
const TEXT_FILES = { focus: 'focus.md', handoffRules: 'handoff-rules.md', contextText: 'context.md' };
const CATEGORY_ID = /^[a-z][a-zA-Z0-9-]{1,39}$/;
const CATEGORY_NAME_MAX = 40;
const CATEGORIES_MAX = 20;
const ENTRIES_MAX = 200;
/** Same limit as the app (LIST_MAX_BYTES): a larger file is refused before it is read. */
export const LIST_MAX_BYTES = 512 * 1024;
/**
 * Characters the app strips from every text (C0/C1 controls except tab and newline, CR, bidi
 * controls, BOM). The build refuses them instead, so the published text is exactly what shows.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜﻿]/u;

/** Paths of every string in `value` that contains a forbidden character. */
export function forbiddenCharacters(value, path = []) {
  if (typeof value === 'string') {
    const match = FORBIDDEN_CHAR.exec(value);
    return match
      ? [`${path.join('.') || '/'} contains U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} (control or bidi character)`]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => forbiddenCharacters(item, [...path, i]));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) => forbiddenCharacters(child, [...path, key]));
  return [];
}

export function loadValidator(schemaPath = join(ROOT, 'schema', 'template-v1.json')) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  return ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
}

function readJson(path, report) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    report(`${err.code === 'ENOENT' ? 'is missing' : `is not valid JSON (${err.message})`}`);
    return undefined;
  }
}

/** A Markdown text without its final newline (editors add one). CRLF is refused by the char check. */
const readText = (path) => readFileSync(path, 'utf8').replace(/\n$/, '');

/**
 * Reads templates/categories.json and every templates/<id>/ folder (template.json plus
 * <lang>/focus.md, handoff-rules.md, context.md). Returns the categories, one entry per folder and
 * every problem found.
 */
export function collect(root = ROOT, validate = loadValidator()) {
  const problems = [];
  const dir = join(root, 'templates');
  const categories = readJson(join(dir, 'categories.json'), (m) => problems.push(`templates/categories.json ${m}`)) ?? [];
  const categoryIds = new Set();
  if (!Array.isArray(categories)) problems.push('templates/categories.json must be an array');
  else {
    if (categories.length > CATEGORIES_MAX)
      problems.push(`templates/categories.json: at most ${CATEGORIES_MAX} categories`);
    for (const category of categories) {
      const id = category?.id;
      const report = (m) => problems.push(`templates/categories.json: ${JSON.stringify(id)} ${m}`);
      if (!CATEGORY_ID.test(id ?? '')) report('is not a category id');
      else if (categoryIds.has(id)) report('is listed twice');
      categoryIds.add(id);
      const names = category?.name;
      if (!names || typeof names !== 'object' || typeof names.en !== 'string' || !names.en.trim())
        report('needs name.en');
      else
        for (const [lang, name] of Object.entries(names))
          if (!LANGUAGES.includes(lang)) report(`name.${lang}: unknown language`);
          else if (typeof name !== 'string' || !name.trim() || name.length > CATEGORY_NAME_MAX)
            report(`name.${lang} must be 1 to ${CATEGORY_NAME_MAX} characters`);
      for (const key of Object.keys(category ?? {}))
        if (key !== 'id' && key !== 'name') report(`unknown field ${key}`);
      for (const problem of forbiddenCharacters(category)) report(problem);
    }
  }

  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  const entries = [];
  const seen = new Set();
  for (const folder of folders) {
    const at = `templates/${folder}`;
    const report = (message) => problems.push(`${at}: ${message}`);
    const meta = readJson(join(dir, folder, 'template.json'), (m) => report(`template.json ${m}`));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      if (meta !== undefined) report('template.json must be an object');
      continue;
    }
    if (meta.id !== folder) report(`id ${JSON.stringify(meta.id)} must equal the folder name`);
    if (seen.has(meta.id)) report(`id ${meta.id} is used twice`);
    seen.add(meta.id);
    if (!categoryIds.has(meta.category))
      report(`category ${JSON.stringify(meta.category)} is not in categories.json`);

    // Texts: the short texts in template.json, the long ones in <lang>/*.md. A language needs both.
    const texts = {};
    for (const lang of Object.keys(meta.texts ?? {}))
      if (!LANGUAGES.includes(lang)) report(`texts.${lang}: unknown language`);
    for (const lang of LANGUAGES) {
      const short = meta.texts?.[lang];
      const langDir = join(dir, folder, lang);
      if (!short && !existsSync(langDir)) continue;
      if (!short || !existsSync(langDir)) {
        report(`${lang} needs both texts.${lang} in template.json and the ${lang}/ folder`);
        continue;
      }
      const long = {};
      for (const [field, file] of Object.entries(TEXT_FILES)) {
        if (field in short) report(`texts.${lang}.${field} belongs in ${lang}/${file}`);
        const path = join(langDir, file);
        if (existsSync(path)) long[field] = readText(path);
        else report(`${lang}/${file} is missing`);
      }
      texts[lang] = { ...short, ...long };
    }
    if (!texts.en) report('English texts are required');
    const entry = { ...meta, texts };
    for (const problem of forbiddenCharacters(entry)) report(problem);
    if (!validate(entry))
      for (const error of validate.errors ?? [])
        report(`${error.instancePath || '/'} ${error.message}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`);
    entries.push(entry);
  }
  if (entries.length > ENTRIES_MAX) problems.push(`at most ${ENTRIES_MAX} templates`);
  return { categories: Array.isArray(categories) ? categories : [], entries, problems };
}

/** The exact list bytes the app verifies (after SIGNING_CONTEXT). */
export function listBytes({ categories, entries, sequence, generatedAt = new Date().toISOString() }) {
  return Buffer.from(
    `${JSON.stringify({ format: TEMPLATE_LIST_FORMAT, catalog: 'templates', generatedAt, sequence, categories, entries }, null, 2)}\n`,
  );
}

/** The bytes that are signed: the domain prefix, then the exact list file. */
export const signedBytes = (bytes) => Buffer.concat([Buffer.from(SIGNING_CONTEXT, 'utf8'), bytes]);

/** Base64 Ed25519 signature over SIGNING_CONTEXT + `bytes`, and the signer's raw public key. */
export function signList(bytes, pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    signature: sign(null, signedBytes(bytes), key).toString('base64'),
    publicKey: publicKey.toString('base64'),
  };
}

/**
 * Reads the published list (`null`: nothing is published yet). Returns its sequence and content,
 * or throws when the file is not a template list, so a bad download never resets the sequence.
 */
export function readPublished(bytes) {
  if (bytes === null) return { sequence: 0, content: null };
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('the published template list is not JSON');
  }
  if (data?.catalog !== 'templates' || !Number.isSafeInteger(data.sequence) || data.sequence < 1)
    throw new Error('the published file is not a template list with a sequence');
  return { sequence: data.sequence, content: JSON.stringify([data.categories, data.entries]) };
}

export function build({
  root = ROOT,
  check = false,
  published = null,
  env = process.env,
  out = join(root, 'dist', 'templates'),
  generatedAt,
} = {}) {
  const { categories, entries, problems } = collect(root, loadValidator(join(root, 'schema', 'template-v1.json')));
  if (problems.length) return { ok: false, problems, entries };
  if (check) {
    const size = listBytes({ categories, entries, sequence: 1 }).length;
    if (size > LIST_MAX_BYTES) return { ok: false, problems: [`the list has ${size} bytes (at most ${LIST_MAX_BYTES})`], entries };
    return { ok: true, problems, entries, categories };
  }
  const pem = env.CONNECTOR_LIST_SIGNING_KEY;
  if (!pem) return { ok: false, problems: ['CONNECTOR_LIST_SIGNING_KEY is not set'], entries };
  const current = readPublished(published);
  rmSync(out, { recursive: true, force: true });
  if (current.content === JSON.stringify([categories, entries]))
    return { ok: true, problems, entries, categories, changed: false, sequence: current.sequence };
  const sequence = current.sequence + 1;
  const bytes = listBytes({ categories, entries, sequence, generatedAt });
  if (bytes.length > LIST_MAX_BYTES)
    return { ok: false, problems: [`the list has ${bytes.length} bytes (at most ${LIST_MAX_BYTES})`], entries };
  const { signature, publicKey } = signList(bytes, pem);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'templates-v1.json'), bytes);
  writeFileSync(join(out, 'templates-v1.json.sig'), `${signature}\n`);
  return { ok: true, problems, entries, categories, changed: true, sequence, publicKey, bytes: bytes.length };
}

function parseArgs(argv) {
  const check = argv.includes('--check');
  const at = argv.indexOf('--published');
  const published = at === -1 ? undefined : argv[at + 1];
  const known = new Set(['--check', '--published', ...(published ? [published] : [])]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]}`);
  if (check === (published !== undefined) || (at !== -1 && !published))
    throw new Error('use --check, or --published <file>|none');
  return { check, published };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let result;
  try {
    const { check, published } = parseArgs(process.argv.slice(2));
    result = build({
      check,
      published: check || published === 'none' ? null : readFileSync(published),
    });
  } catch (err) {
    result = { ok: false, problems: [err.message] };
  }
  if (!result.ok) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    console.error(`${result.problems.length} problem(s); nothing was built.`);
    process.exit(1);
  }
  console.log(`✓ ${result.entries.length} templates in ${result.categories.length} categories valid`);
  if (result.changed === false)
    console.log(`✓ unchanged since the published list (sequence ${result.sequence}); nothing to publish`);
  else if (result.changed)
    console.log(
      `✓ dist/templates/templates-v1.json: sequence ${result.sequence}, ${result.bytes} bytes, signed by ${result.publicKey}`,
    );
}
