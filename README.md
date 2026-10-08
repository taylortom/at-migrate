# at-migrate

A command-line tool for migrating content from the **legacy Adapt authoring tool** ([`adaptlearning/adapt_authoring`](https://github.com/adaptlearning/adapt_authoring)) into the **v1 Adapt authoring tool** ([`adapt-security/adapt-authoring`](https://github.com/adapt-security/adapt-authoring)).

It works in two phases:

1. **Export** – run against your **legacy** installation to write roles, users, courses and theme presets to a self-contained bundle on disk.
2. **Import** – run against your **v1** installation to load that bundle in via the v1 API.

The two phases talk only through files on disk, so you can export and import on different machines, and resume an interrupted run.

---

## Requirements

- **Node.js** — the **export** phase needs 16.7+ (it can run on the legacy server); the **import** phase needs 18+ (ideally 22+).
- Local access to your **legacy `adapt_authoring` source tree**, with its dependencies installed (the exporter boots the legacy app to build courses).
- Access to the legacy installation's **MongoDB** (the tool reads the connection string from its `conf/config.json`).
- For import: the URL of your **v1 `adapt-authoring` API** and an **auth token** for a user with sufficient permissions.
- The **import phase must run on the same machine as the v1 app** — it unpacks each course locally and hands the API a filesystem path, not an upload.

## Usage

Run it with `npx` — no install needed:

```bash
npx taylortom/at-migrate <action> [flags]
```

| Action   | Description                                              |
|----------|----------------------------------------------------------|
| `export` | Export content from a legacy installation to disk.       |
| `import` | Import a previously exported bundle into a v1 instance.   |
| `export-remote` | Export content from a legacy site over its web API, with no server access. |

| Flag            | Applies to        | Description                                                       |
|-----------------|-------------------|-------------------------------------------------------------------|
| `--debug`       | `export`,`import` | Verbose logging and full stack traces on error.                   |
| `--limit=<n>`   | `export`,`import` | Process at most `n` courses (handy for a trial run).              |
| `--no-courses`  | `export`          | Export metadata only; skip building the course `.zip` files.      |
| `--url=<url>`   | `export-remote`   | The legacy site's URL.                                            |
| `--credentials=<file>` | `export-remote` | A JSON file holding `email` and `password` (or set `AT_MIGRATE_EMAIL`/`AT_MIGRATE_PASSWORD`). |
| `--courses=<ids>` | `export-remote` | Comma-separated course ids to export; all courses by default.  |
| `--out=<dir>`   | `export-remote`   | Where to write the bundle; defaults to `./at-migrate`.            |

You will be prompted for anything not supplied on the command line.

### Exporting

```bash
npx taylortom/at-migrate export
```

You'll be asked for the path to your legacy app and whether to force a full rebuild of each course. The export is written to an `at-migrate/` folder under your legacy app. If a previous export didn't finish, you can choose to continue or restart it.

When it finishes you'll see a summary of how many courses succeeded and failed, along with any warnings — records that were exported with something dropped, or skipped entirely. Warnings are also saved to `export.json`.

### Exporting remotely

```bash
npx taylortom/at-migrate export-remote --url=https://legacy.example.com --credentials=creds.json
```

Use this when you can reach the legacy site in a browser but not its server. It logs in as a **Super Admin** (once — a rejected login is never retried, so it can't lock the account), reads everything through the site's API, and assembles each course zip locally. It only ever reads from the site: no builds run on the server.

The bundle has the same shape as a normal export and is imported the same way, with two differences:

- **Plugin source isn't included.** Each course zip carries a `bower.json` stub per plugin (name, version, target attribute), which is enough for content migration. Install your plugins, theme and menu on the v1 instance first: a remote bundle never installs plugins, and any still missing on import are quarantined. A missing theme or menu fails that course.
- **Custom styling data is noted alongside the bundle**, in `theme-data/`. The v1 import drops theme and menu attributes when the plugin isn't installed, and classes and custom LESS only mean something against the theme they were written for, so this keeps a record for the theme migration:
  - `themes/` and `menus/` — each theme's and menu's properties.schema, where it has one (legacy only keeps its `properties`).
  - `<courseId>.json` — per course: every class and where it's used (from `_classes` or from rich text), inline styles in rich text, content carrying the theme's or menu's own attributes, theme variables and preset values that differ from the theme's defaults, the course's custom LESS with the variables and classes it references, and its screen-size breakpoints.
  - `summary.json` — per theme and menu: the courses using it, and how many of them use each class, inline style property, LESS reference and set of breakpoints.

  `export.json` also carries a short `theme` summary per course. Assets linked to a course's theme rather than its content aren't exported (as with a normal export), but are listed and warned about.
- **Schema defaults aren't baked in.** The legacy build fills in defaults (e.g. `_globals` strings) that the v1 import applies from its own schemas instead.

### Importing

```bash
npx taylortom/at-migrate import
```

You'll be asked to point at the export, and for your v1 API URL and auth token. The importer recreates users (prompting you once to map old roles to new ones), migrates theme presets, and imports each course. Each course keeps its original owner and sharing settings, remapped to the newly created users. Existing users and courses are detected and skipped, and progress is saved as it goes — so if an import is interrupted you can re-run it and continue where it left off.

When it finishes you'll see a summary of how many courses succeeded, failed and were skipped, along with any warnings — courses that imported, but with something dropped along the way (an unmappable owner, a share with a user that no longer exists). Warnings are also saved to `import.json`.

---

## Notes

- **Install your plugins and themes on the v1 instance before you import.** Legacy course content is migrated on import, but only up to the versions *already installed* — a plugin the instance doesn't have is installed at the old version out of the export, and its content is then never migrated. Migration will otherwise look like it ran while doing nothing for exactly the plugins that needed it.
- **Hero images** were recently re-enabled — verify they appear correctly on imported courses before relying on it.
- **Sharing and ownership** are migrated onto v1's `_access` object (`_isShared` → `_access.public`, `_shareWithUsers` → `_access.users`), and the original owner is restored with a follow-up patch after each import. Courses imported before this was added will have been left owned by the importing user, and — because v1 defaults `_access.public` to `true` — most likely visible to everyone. Check those before assuming they're private.
- **Theme styling** comes from the course's own theme variables, which hold any changes made since a preset was applied; the preset's values are only used for a course with none of its own. Either way it's only kept if the course's theme is installed in your v1 instance; otherwise the styling is dropped on import.
- **Dirty legacy data is dropped, not fatal.** A user pointing at a role that no longer exists has that reference removed; one with no email address can't be recreated at all and is skipped, so any course it owns imports unowned. Neither stops the export any more, but both are reported in the summary and in `export.json` — read them before you import, as a user can end up with no roles.
- **Auth tokens and database details are stored in plain text** in the export folder. Treat it as sensitive.
- This tool targets the specific `adapt_authoring` → `adapt-authoring` migration and is not a general-purpose tool.

## License

GPL-3.0 © Thomas Taylor
