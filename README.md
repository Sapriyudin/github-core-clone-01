# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sapriyudin/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sapriyudin/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![Node](https://img.shields.io/badge/node-22-green)](https://nodejs.org/)

A single-process, dependency-free (Node 22 stdlib only) GitHub-compatible
git forge, built for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
($500). One process serves all four surfaces from one in-memory store:

- **Git smart HTTP** — protocol v2 (when the client asks with
  `Git-Protocol: version=2`) and v0, `ls-refs` (peel/symrefs/unborn/
  ref-prefix), fetch with shallow/deepen and have-exclusion, and v0
  receive-pack with report-status, fast-forward enforcement and mixed
  ok/ng reports. Packs are undeltified; fetch packs are cached.
- **REST v3** — repositories, git refs, branches, commits, contents
  (create/update/delete with blob-sha optimistic locking), labels, issues,
  comments and pull requests with squash merge and 3-way conflict
  detection. Every reply is JSON with `X-GitHub-Request-Id`.
- **GraphQL v4** — the viewer/repository/issue/pull-request reads gh and
  github-mcp-server send, `__type` introspection, Relay global ids,
  cursor pagination, operation batching, and the create/close/merge/
  comment mutations.
- **MCP** — Streamable HTTP, both the 2026-07-28 `server/discover` era
  and the legacy `initialize` handshake; six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Local conformance

Against the kit's sealed local suite (`sdk/run.ts --perf`):

- **120/120 conformance checks** (feature 600/600, agent 200/200)
- **Benchmarks 120/200** — push 29, clone 30, read 33, write 28
- **Total 920/1000** on this machine (reference forge ≈ 900)

## Run

```sh
MAKEFUN_SHOP_TOKEN=<trial token> node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register
it, poll until done, exit 0); `app.ts` is the server. No dependencies,
no network beyond the suite, no model calls.
