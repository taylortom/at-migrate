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

## Usage

Run it with `npx` — no install needed:

```bash
npx taylortom/at-migrate <action> [flags]
```

| Action   | Description                                              |
|----------|----------------------------------------------------------|
| `export` | Export content from a legacy installation to disk.       |
| `import` | Import a previously exported bundle into a v1 instance.   |

| Flag            | Applies to        | Description                                                       |
|-----------------|-------------------|-------------------------------------------------------------------|
| `--debug`       | `export`,`import` | Verbose logging and full stack traces on error.                   |
| `--limit=<n>`   | `export`,`import` | Process at most `n` courses (handy for a trial run).              |
| `--no-courses`  | `export`          | Export metadata only; skip building the course `.zip` files.      |

You will be prompted for anything not supplied on the command line.

### Exporting

```bash
npx taylortom/at-migrate export
```

You'll be asked for the path to your legacy app and whether to force a full rebuild of each course. The export is written to an `at-migrate/` folder under your legacy app. If a previous export didn't finish, you can choose to continue or restart it.

### Importing

```bash
npx taylortom/at-migrate import
```

You'll be asked to point at the export, and for your v1 API URL and auth token. The importer recreates users (prompting you once to map old roles to new ones), migrates theme presets, and imports each course. Existing users and courses are detected and skipped, and progress is saved as it goes — so if an import is interrupted you can re-run it and continue where it left off.

When it finishes you'll see a summary of how many courses succeeded, failed and were skipped.

---

## Notes

- **Hero images** were recently re-enabled — verify they appear correctly on imported courses before relying on it.
- **Theme presets** are only applied to a course if that course's theme is installed in your v1 instance; otherwise the styling is dropped on import.
- **Auth tokens and database details are stored in plain text** in the export folder. Treat it as sensitive.
- This tool targets the specific `adapt_authoring` → `adapt-authoring` migration and is not a general-purpose tool.

## License

GPL-3.0 © Thomas Taylor
