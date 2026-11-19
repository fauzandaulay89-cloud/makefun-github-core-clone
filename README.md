# A GitHub-Compatible Git Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fauzandaulay89-cloud/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fauzandaulay89-cloud/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for [make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC. Referral code: `fxram5cz`.

A GitHub-compatible git forge built from scratch (Node 22, TypeScript, stdlib
only — no dependencies, no git binary, no outbound network).

One process serves:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, ls-refs, fetch with shallow/deepen) with a v0
  fallback, and receive-pack v0 (`report-status`, `side-band-64k`,
  `delete-refs`, fast-forward only).
- **REST v3** at `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merge.
- **GraphQL** at `/api/graphql` — repositories, issues, pull requests,
  mutations, and `__type`/`__schema` introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with a 2025-11-25 legacy handshake, six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

All four surfaces share one deterministic in-memory store (`store.ts`):
repos, issues, pulls, contents, and git objects (blob/tree/commit/tag) with
pack read/write. No clock or randomness appears in exported output, so two
runs replay byte-identically.

## Run

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, POSTs `{"port": n}` to
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until
`{"done": true}` and exits 0.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entry lifecycle: bind, register, poll done, exit. |
| `app.ts` | HTTP server, routing, auth. |
| `store.ts` | Deterministic store: git objects, packs, repos/issues/pulls. |
| `git.ts` | pkt-line framing, v0/v2 advertisements, fetch planning, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser + executor + introspection. |
| `mcp.ts` | MCP JSON-RPC server and the six tools. |

## License

MIT — see `LICENSE`.
