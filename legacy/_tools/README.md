# Yumlog Developer Tools

Python scripts for maintaining the Yumlog cookbook. Both active scripts are run automatically by GitHub Actions on every push to `main` that touches `recipes/`; you can also run them locally.

## Workflow

Recipes are hand-authored as Markdown files in `recipes/`. When a change to `recipes/` is pushed to `main`, the GitHub Actions workflow automatically runs `search_prep.py` and `update_indexes.py` to regenerate `search.json` and all index pages, then commits the results back to `main`.

## Scripts

### `update_indexes.py`

Regenerates the index pages by category, protein, and alphabet from recipe front matter. Writes pages in `/category/`, `/protein/`, and `/indexes/`.

### `search_prep.py`

Generates `search.json` in the repo root for client-side search. Scans recipe Markdown files and extracts title, summary, categories, protein types, and cook time.

## Running locally

```bash
pip install -r requirements.txt
python _tools/search_prep.py
python _tools/update_indexes.py
```

## Archive

`archive/` contains deprecated scripts superseded by the active ones above:

| File | Notes |
|---|---|
| `import_from_form.py` | Old Google Form import script — recipes are now hand-authored |
| `alphabet_generator.md` | Old Obsidian Dataview query — replaced by `update_indexes.py` |
| `category_generator.md` | Old Obsidian Dataview query — replaced by `update_indexes.py` |
| `protein_generator.md` | Old Obsidian Dataview query — not actively used |
| `update_category.py` | Old Python script — superseded by `update_indexes.py` |
