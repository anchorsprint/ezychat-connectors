# EzyChat connectors

The list of connectors that EzyChat (Lite and Enterprise) shows in **Admin → Connectors**. Each
connector lives in its own folder here. On every merge to `main`, one signed JSON list is built from
the folders and published to `https://dl.ezychat.ai/connectors/`. Each EzyChat app downloads it at
start and when an admin opens Admin → Connectors, checks it, and keeps a local copy.

When a customer connects a partner connector, their own EzyChat talks **directly** to the partner's
MCP server from their computer. Nothing goes through an EzyChat server, and the app contacts no
partner before the customer clicks Connect.

## Folder layout

```text
schema/connector-v1.json            JSON Schema of one entry (schemaVersion 1); generated from the app
connectors/<id>/connector.yaml      the entry: texts (en/ms/zh-CN), category, publisher, MCP address,
                                    sign-in, tools, guards, settings
connectors/<id>/skill.md            instructions for the AI (optional; skill.ms.md, skill.zh-CN.md
                                    optional, English is the fallback)
connectors/<id>/icon.svg            square icon (or icon.png), at most 256 KB
order.yaml                          gallery order (ids listed first; the rest follow by id)
scripts/build.mjs                   validates every entry, builds the list, signs it
.github/workflows/ci.yml            pull requests: tests + validation
.github/workflows/publish.yml       merge to main: test, build, sign, upload to dl.ezychat.ai
```

Published files:

| File                                                  | What                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| `https://dl.ezychat.ai/connectors/list-v1.json`       | the list (format 1)                        |
| `https://dl.ezychat.ai/connectors/list-v1.json.sig`   | base64 Ed25519 signature of its exact bytes |
| `https://dl.ezychat.ai/connectors/icons/<id>.svg`     | icons, each listed with its SHA-256 and size |

## Add a connector (pull request)

Anyone may propose a connector. Anchor Sprint reviews every pull request; only the owner merges.

1. Fork this repository and add the folder `connectors/<id>/` (`id`: a–z, 0–9 and `-`).
2. Write `connector.yaml`. Use an existing folder as the model; the keys are the fields of
   [`schema/connector-v1.json`](schema/connector-v1.json). Texts are maps per language
   (`en` is required, `ms` and `zh-CN` are optional). Write `icon: icon.svg`.
3. Add `icon.svg` (a simple square icon without scripts, event handlers or `javascript:` links).
4. If the AI needs instructions for your tools, write them in `skill.md` (at most 6,000 characters).
5. Run the checks:

   ```bash
   npm ci
   npm test
   node scripts/build.mjs --check
   ```

6. Open the pull request. CI runs the same checks.

The build replaces `icon: icon.svg` with `{ file: "<id>.svg", sha256, size }` and inlines
`skill.md` as `skill`. One signature covers every text, skill and icon.

## Review rules

A pull request is merged only when:

- the MCP server address is `https` and belongs to the publisher named in the entry;
- `privacy` says plainly who receives which data;
- every tool that changes data has `access: write` and suitable `guards` (for example
  `confirmFirst`, `valueFrom`, `limits`); tools that delete or undo earlier results are not listed;
- `skill` only describes how to use the tools; it never asks the AI to ignore EzyChat's rules;
- the texts are correct in every language they give, and the icon is the publisher's own or free to use;
- there is **no secret** anywhere (see below).

## No secrets, ever

The list is public: the signature proves where it comes from, not that it is secret. Never put a
client secret, API key, token or password in a connector. The admin types their own key in EzyChat,
which keeps it encrypted on their computer. The build refuses any field whose name looks like a
secret (`secret`, `password`, `token`, `apiKey`, …); the only exception is the `secret: true|false`
flag of a `credentials` form field.

## Sign-in types (`auth.type`)

| `auth.type`     | For                                                                                                              | The admin                                            | EzyChat sends                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `oauth`         | MCP authorization (discovery, dynamic client registration, or a public `clientId`), PKCE S256, loopback redirect | Connect, sign in on the partner's page               | `Authorization: Bearer <token>`, refreshed                                  |
| `oauth_own_app` | OAuth without self-registration that needs a client secret                                                       | pastes their own client ID and secret, then signs in | as above                                                                    |
| `api_key`       | one key or token                                                                                                 | pastes the key, Test, Save                           | a declared header, e.g. `Authorization: Bearer {key}` or `X-API-Key: {key}` |
| `credentials`   | several fields (account ID + key, username + password)                                                           | fills the declared form                              | headers from templates, e.g. `Authorization: Basic {username:password}`     |
| `none`          | public read-only servers                                                                                         | Connect                                              | nothing                                                                     |

- `mcp.url` may use a non-secret field (`https://{tenant}.partner.example/mcp`); the result must be `https`.
- A new `auth.type` needs a new schema version; an older app does not show such an entry.

## Kinds

| `kind`        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `mcp`         | a partner's MCP server; needs `mcp`, `auth` and `tools`                    |
| `builtin`     | a connector built into the app (`builtinId`); the entry gives its texts    |
| `coming_soon` | not available yet; the gallery shows **Vote for this connector** (`vote`)  |

## Versions

- **List format** (`format: 1`): the shape of `list-v1.json`. An app that cannot read a format keeps
  its last good copy.
- **Schema version** (`schemaVersion` of each entry): an app shows an entry only when it supports its
  schema version **and** its own version is at least `minAppVersion`. Within one schema version,
  fields are only added and optional. A breaking change gets a new schema version; older apps then
  hide only that entry.
- **Sequence**: increases on every publish (seconds since 1970, or `LIST_SEQUENCE`). An app never
  accepts a lower sequence than the copy it has, so an old list cannot be replayed.
- `schema/connector-v1.json` is generated from the app's contract
  (`packages/shared/src/connector-list.ts` in ezychat-lite) with
  `npx tsx scripts/connector-schema.mjs <file>` there. Copy it here when the contract changes.

## Signing keys

The list is signed with Ed25519. The private key exists only as the secret
`CONNECTOR_LIST_SIGNING_KEY` (PKCS #8 PEM) of the protected `release` environment of this
repository; it never appears in the repository. The app holds two public keys (the current one and
the next one), so the key can change without breaking installed apps. The build prints the public key
it signed with; it must be one of the keys in the app (`packages/server/src/connectors/list/keys.ts`).

A publish uploads the icons, then the signature, then the list. An app that downloads during the
few seconds between the two last uploads refuses that pair and keeps its last good copy until the
next check. Old icons stay in the bucket (the list names only the current ones).
