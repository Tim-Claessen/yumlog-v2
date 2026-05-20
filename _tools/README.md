# Yumlog Developer Tools

Python scripts for maintaining the Yumlog cookbook. All three active scripts are run automatically by GitHub Actions; you can also run them locally.

## Scripts

### `import_from_form.py`

Fetches new recipe submissions from the Google Form (via linked Google Sheet) and converts them into Markdown files in `/recipes/`. Skips duplicates based on timestamp.

Requires `_secrets/google_service_account.json` locally. In production, the GitHub Actions workflow loads credentials from the `GOOGLE_SERVICE_ACCOUNT_JSON` secret.

### `update_indexes.py`

Regenerates the index pages by category, protein, and alphabet from recipe front matter. Writes pages in `/category/`, `/protein/`, and `/indexes/`.

### `search_prep.py`

Generates `search.json` in the repo root for client-side search. Scans recipe Markdown files and extracts title, summary, categories, protein types, and cook time.

## Running locally

```bash
pip install -r requirements.txt
python _tools/import_from_form.py
python _tools/update_indexes.py
python _tools/search_prep.py
```

## Archive

`archive/` contains deprecated scripts superseded by the active ones above:

| File | Notes |
|---|---|
| `alphabet_generator.md` | Old Obsidian Dataview query — replaced by `update_indexes.py` |
| `category_generator.md` | Old Obsidian Dataview query — replaced by `update_indexes.py` |
| `protein_generator.md` | Old Obsidian Dataview query — not actively used |
| `update_category.py` | Old Python script — superseded by `update_indexes.py` |
