# Work In Progress

Features and tools that are not yet production-ready. Nothing in this folder is deployed to the live site.

## `ai_generator.md`

A Jekyll page for an AI-powered recipe generator. Calls a Netlify function endpoint (`yumlog.netlify.app`) that is not yet fully operational. Kept here until the backend is wired up and ready to ship.

## `images/`

An image processing pipeline for converting and compressing recipe photos before publishing.

| File | Purpose |
|---|---|
| `image_prep.py` | Batch-converts source images to WebP with compression |
| `raw/` | Drop source images here before running the script |
| `requirements.txt` | Python dependency (`pillow`) |

To use:

```bash
pip install -r _wip/images/requirements.txt
python _wip/images/image_prep.py
```

Output WebP images are written to `/images/` in the repo root.
