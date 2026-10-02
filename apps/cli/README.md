# Shelter CLI

The Shelter CLI is the script-friendly command-line client for a self-hosted Shelter installation. It creates and inspects projects, triggers deployments, streams logs, replaces uploaded source archives, and manages project domains through the Shelter API.

## Requirements

- Node.js 24 or newer
- A running Shelter installation
- A Shelter personal API token with the scopes required by the command

Create a token in **Settings → API & CLI** in the Shelter dashboard. The token is shown once.

## Install

After the first npm release is published:

```sh
npm install --global @shelter/cli
shelter --help
```

Or run without a global installation:

```sh
npx --yes @shelter/cli --help
```

Pin `@shelter/cli@<version>` for reproducible agent environments. The npm package
requires Node.js 24 or newer and includes built JavaScript with no runtime
dependencies or install scripts. Stable releases use `latest`; prereleases use
`next` (`npm install --global @shelter/cli@next`). Package versions follow Shelter
release versions. Registry installation is only available after npm ownership
and trusted publishing have been configured and a first package published.

### Build from source

Build the CLI from the Shelter monorepo and install the executable globally:

```sh
git clone https://github.com/raum-so/shelter.git
cd shelter
npm ci
npm run build -w @shelter/cli
npm install --global ./apps/cli
```

From the repository root, use `npm run cli -- --help` after building. No global installation is needed.

The package name is `@shelter/cli` and the installed executable is `shelter`.

## Log in

Interactive login keeps the token out of shell history:

```sh
shelter login --server https://hosting.example.com
```

For CI or another non-interactive environment, pass the token over standard input:

```sh
printf '%s' "$SHELTER_TOKEN" | shelter login \
  --server https://hosting.example.com \
  --token-stdin
```

Credentials are stored in `$XDG_CONFIG_HOME/shelter/config.json`, or `~/.config/shelter/config.json` when `XDG_CONFIG_HOME` is not set. The directory is created with mode `0700` and the file with mode `0600`.

`SHELTER_URL` and `SHELTER_TOKEN` override stored credentials. Changing the server requires an explicit token or a new login; a saved token is never sent to a different server. This is the recommended configuration for CI:

```sh
export SHELTER_URL=https://hosting.example.com
export SHELTER_TOKEN='shelter_pat_v1_…'
shelter whoami
```

## Commands

```text
shelter whoami
shelter projects
shelter project <project-id>

shelter create git \
  --name "My app" \
  --repository https://github.com/example/my-app.git \
  --branch main

shelter deploy <project-id>
shelter deploy <project-id> --wait
shelter cancel <deployment-id>
shelter rollback <deployment-id>
shelter rollback <deployment-id> --wait
shelter logs <deployment-id>
shelter logs <deployment-id> --follow

shelter upload <project-id> ./release.zip
shelter upload <project-id> ./release.zip --wait

shelter domains <project-id>
shelter domain add <project-id> app.example.com --zone <cloudflare-zone-id>
shelter domain remove <project-id> <domain-id>

shelter logout
```

`upload` replaces the source of an existing upload-based project. It uses Shelter's chunked upload API, validates the archive server-side, and queues a deployment. Git projects should use `deploy`, which fetches the current repository branch.

`cancel` requests cooperative cancellation of a queued or running deployment. Shelter terminates the active build process and cleans up its candidate container before reporting the deployment as cancelled. Deployments that are already activating cannot be cancelled because Shelter is completing an atomic production switch.

`rollback` creates a new immutable deployment from the selected ready version. The current production version stays online until the restored version passes its health check; use `--wait` to return only after the rollback has reached a terminal state.

## JSON output

Add `--json` anywhere in a command for machine-readable output:

```sh
shelter projects --json
shelter --json deploy prj_123 --wait
```

Regular commands emit one JSON document. `logs --follow --json` is a stream and emits newline-delimited JSON (NDJSON): one object per log followed by a completion object.

Progress messages are written to standard error, keeping standard output safe to pipe into another program.

## Agent workflow

Use `SHELTER_URL` and `SHELTER_TOKEN` from your secret store. Run:

```sh
shelter commands --json
shelter whoami --json
shelter schema
shelter overview
shelter projects --json
shelter project prj_123 --json
shelter project-update prj_123 --input project-settings.json
shelter deploy prj_123 --wait --json
shelter deployment dep_123
shelter logs dep_123 --json
```

`commands` is available offline and describes the additional commands, their
HTTP paths and scopes. `schema` reads the installed server's OpenAPI document;
its request schemas are not exhaustive, so also consult [the API guide](https://github.com/raum-so/shelter/blob/main/docs/API.md).
Existing human-friendly commands retain `--json`. The additional agent commands
always return JSON. `--help --json` and `--version --json` are machine-readable.

Use JSON files or stdin for configuration, never secrets in command arguments:

```sh
shelter create git --input project.json --json
shelter create upload ./source.zip --input project.json --wait --json
shelter analyze --input file-facts.json
shelter environment prj_123 --input - < production-environment.json
shelter previews prj_123
shelter preview-settings prj_123 --input preview-settings.json
shelter preview-environment prj_123 --input - < preview-environment.json
shelter preview-delete prj_123 prv_123
shelter zones
shelter domain-access prj_123 dom_123 --input - < domain-access.json
shelter domain-revoke prj_123 dom_123
shelter project-delete prj_123 --input confirmation.json
```

Environment bodies have the form `{"variables":[{"key":"NAME","value":"value"}]}`.
They replace the variable list; omitted keys are removed, and omitting `value`
for an existing key retains its stored value. Preview variables are isolated
from production. Project deletion requires `{"confirmation":"Exact project name"}`.
These commands execute immediately without interactive confirmations. Keep
sensitive input files outside source control. `analyze` accepts explicitly supplied
file facts and does not scan your working tree or read real `.env` files.

For additional JSON API operations:

```sh
shelter api GET '/api/deployments/dep_123/logs?after=42' --json
shelter api POST /api/projects/prj_123/deploy --input deployment.json --json
```

The generic command only accepts installation-relative `/api/` paths and JSON
object bodies. It does not expose cookies, bypass scopes, or support binary/SSE
responses; use `upload` and `logs --follow` for their respective workflows.
Provider connection setup, GitHub linking, token administration, password changes,
server metrics and runtime observability remain browser-session-only. An API
token cannot perform those operations, even through `api`.

Successful regular commands write one JSON document to stdout. In `--json` mode,
errors write one `{error, code, status?}` object to stderr with exit code 1.
Argument/configuration errors use `CLI_ERROR`; HTTP errors preserve the server's
code and status. A failed or cancelled `--wait` deployment returns its final
state on stdout and exits 1. Success exits 0. Follow mode uses NDJSON.
HTTP requests time out after 30 seconds; deployment wait and log follow stop
after 30 minutes without cancelling the remote deployment. Mutations are never
automatically retried. Inspect state before retrying an ambiguous network failure.

The CLI was imported from `asteinberger/shelter-cli` revision
`e342426dbe2b0e0e6407ee3cbadc6b90f3981edb`; development now happens here.

## Security notes

- The CLI never prints the raw API token.
- Prefer the hidden interactive prompt or `--token-stdin`; do not put tokens directly in command arguments.
- Use a narrowly scoped token for automation and set an expiration date.
- `shelter logout` removes stored credentials, but cannot unset `SHELTER_URL` or `SHELTER_TOKEN` from your shell.
- Revoke a token from the Shelter dashboard if it may have been exposed.

## Development

From the monorepo root, `npm run cli:pack` builds a release-versioned tarball in
`dist/cli/`; `npm run test:cli-package` verifies an isolated offline installation.
The full `npm run check` includes both steps. See the
[release setup](https://github.com/raum-so/shelter/blob/main/docs/RELEASES.md#cli-distribution-on-npm)
for npm ownership and trusted publishing.

```sh
npm run typecheck
npm test
npm run build
```

The CLI has no runtime dependencies and uses the Fetch API included with Node.js 24.

## License

[AGPL-3.0-only](https://github.com/raum-so/shelter/blob/main/LICENSE)
