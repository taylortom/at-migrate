# at-migrate

A command-line tool for migrating content from the **legacy Adapt authoring tool** ([`adaptlearning/adapt_authoring`](https://github.com/adaptlearning/adapt_authoring)) into the **v1 Adapt authoring tool** ([`adapt-security/adapt-authoring`](https://github.com/adapt-security/adapt-authoring)).

The two tools share course content but differ fundamentally in architecture (the v1 tool is an API-first rewrite), so content cannot simply be copied between databases. `at-migrate` bridges them in two distinct phases:

1. **Export** – Run against the **legacy** installation. Reads roles, users and courses directly from the legacy MongoDB, boots the legacy app to drive its `adapt` output plugin, and writes a self-contained export bundle (metadata + course `.zip` files) to disk.
2. **Import** – Run against (or alongside) the **v1** installation. Reads the export bundle, authenticates against the v1 HTTP API, maps legacy roles to v1 roles, recreates users, and imports each course `.zip` through the v1 API.

The phases communicate purely through files on disk, so export and import can run on different machines at different times, and an interrupted import can be resumed.

---

## Requirements

- **Node.js** (ESM is used, so Node 16+ is required; Node 18+ recommended for the global `fetch`).
- Local access to the **legacy `adapt_authoring` source tree** (the directory containing `conf/config.json`, `lib/application`, `data/`, `temp/`). The exporter boots this app in-process, so its dependencies must be installed.
- Access to the legacy installation's **MongoDB** (read from `conf/config.json` → `dbConnectionUri`).
- For import: a reachable **v1 `adapt-authoring` API** URL and a valid **auth token** for a user with sufficient scopes.

## Installation

```bash
git clone https://github.com/taylortom/at-migrate.git
cd at-migrate
npm install
```

This installs `chalk`, `mongodb`, `prompts` and `zipper` (the latter from the `adapt-security/zipper` GitHub repo).

You can run the tool directly with `node index.js <action>` or, since `package.json` declares a `bin`, link it globally with `npm link` and call `at-migrate <action>`.

---

## Usage

```bash
node index.js <action> [flags]
```

### Actions

| Action   | Description                                                                 |
|----------|-----------------------------------------------------------------------------|
| `export` | Export roles, users and courses from a legacy `adapt_authoring` installation to disk. |
| `import` | Import a previously exported bundle into a v1 `adapt-authoring` instance via its API. |

### Flags

| Flag            | Applies to        | Description                                                                 |
|-----------------|-------------------|-----------------------------------------------------------------------------|
| `--debug`       | `export`,`import` | Enable verbose `DEBUG::` logging and print stack traces on error.            |
| `--limit=<n>`   | `export`,`import` | Process at most `n` courses. Useful for trial runs.                          |
| `--no-courses`  | `export`          | Export only metadata (roles/users/course records); skip building course zips.|

You will be prompted interactively for any values not supplied (source path, force-rebuild choice, API URL, auth token, which export to continue, etc.).

---

### Exporting

```bash
node index.js export
```

You will be prompted for:

- **Path to the legacy app source** – the root of the old AAT install (defaults to the current directory).
- **Force rebuild** – whether to run a full rebuild of each course before exporting.

The exporter then:

1. Loads `conf/config.json` and connects to the legacy MongoDB.
2. Boots the legacy app (so its `adapt` output plugin is available) with the current user overridden to the installation's *Super Admin*.
3. Exports `roles` and `users` (mapped down to the fields needed by the import phase).
4. Exports `themepresets` (course theme presets), and records each course's preset link (read from the `config` collection's `_themePreset`).
5. Exports each `course`: builds a `.zip` via the legacy `adapt` output plugin and copies it into the export folder.
6. Writes everything to `export.json` and stops the legacy app.

**Output layout** (written under the source path):

```
<sourcePath>/at-migrate/<timestamp>/
├── export.json        # roles, users, theme presets, courses metadata + success/error status
├── <courseId>.zip     # one Adapt course zip per exported course
└── heroes/            # (reserved for course hero images)
```

If a previous, incomplete export exists, you will be offered the choice to **Continue** it or **Restart**.

### Importing

```bash
node index.js import
```

You will be prompted for:

- **Path to the source** – either the legacy app source (the tool will look for a nested `at-migrate/` folder) or the `at-migrate/` export folder itself.
- **Which export to restore** – choose one of the timestamped export folders.
- **API URL** – the base URL of the v1 `adapt-authoring` API (stored in `import.json` after first entry).
- **Auth token** – a bearer token for the v1 API (requested if missing or expired).

The importer then:

1. Authenticates against the v1 API (`auth/check`).
2. Compares exported course titles against courses already present in the v1 instance, and offers to **Continue**, **Restart** or **Exit**.
3. **Imports users**: prompts you once to map each legacy role to a v1 role, then registers each missing user (existing users, matched by email, are skipped). Imported users are created with a random password.
4. **Imports theme presets**: creates each exported preset as a `coursethemepresets` record (presets matching an existing one by `displayName` + `parentTheme` are skipped).
5. **Imports courses**: unzips each course bundle, strips blacklisted plugins (currently `adapt-notepad`), and — if the course had a theme preset — writes the preset's variables into the bundle's `course.json` as `themeVariables` so they persist when the course is created. It then posts the bundle to the v1 API's `adapt/import` endpoint. (This is equivalent to the coursetheme module's apply route, which only sets `themeVariables`; it requires the preset's `parentTheme` to be installed in the target, otherwise the import strips the unknown variables.)

Progress is persisted to `import.json` after each course, so an interrupted import can be safely resumed.

On completion a summary is printed:

```
## Import completed.
## Success: <n>
## Error:   <n>
## Skipped: <n>
## See <sourcePath>/at-migrate/export.json for full details.
```

---

## How it works (file overview)

| File                | Role                                                                          |
|---------------------|-------------------------------------------------------------------------------|
| `index.js`          | CLI entry point. Parses the action and flags and dispatches export/import.    |
| `lib/Exporter.cjs`  | Export phase: reads legacy DB, drives the legacy `adapt` output plugin.       |
| `lib/Importer.js`   | Import phase: talks to the v1 `adapt-authoring` HTTP API.                      |
| `lib/Utils.cjs`     | Shared helpers: JSON read/write and paginated API requests.                   |

---

## Notes & known limitations

- **Hero image migration was recently re-enabled and should be verified against a live v1 instance.** Hero images are copied during export, and on import the file is placed in the course's `src/course/en/assets/` folder with `course.json`'s `heroImage` set to the src-relative asset path. This had previously been disabled; confirm hero images render correctly after an import before relying on it.
- **Auth tokens and the DB connection string are stored in plaintext** on disk (`import.json` / read from `config.json`). Treat the export folder as sensitive.
- The `adapt-notepad` extension is stripped from courses during import (see `pluginBlacklist` in `lib/Importer.js`).
- This tool is purpose-built for the `adapt_authoring` → `adapt-authoring` migration and assumes the legacy directory structure and the v1 API's contract; it is not a general-purpose tool.

## License

GPL-3.0 © Thomas Taylor
