# Xuanpu Website

Static production website for `https://xuanpu.clawplay.club`.

This directory is intentionally separate from `docs/`:

- `website/` is the public product website.
- `docs/` remains repository documentation and historical project notes.

## Local Preview

The site is static and can be opened directly:

```bash
open website/index.html
```

For a local HTTP preview:

```bash
python3 -m http.server 4177 --directory website
```

Then open:

```text
http://127.0.0.1:4177
```

## Deploy

Copy the contents of `website/` to the server web root, for example:

```bash
rsync -av --delete website/ user@server:/var/www/xuanpu/
```

Use `website/nginx/xuanpu.clawplay.club.conf` as the nginx site config template.

## Assets

The website uses copied brand assets under `website/assets/` so deployment is self-contained.
Canonical sources stay in:

```text
resources/brand/
resources/icon.png
docs/social-preview.png
```

If brand assets are regenerated, copy the final public assets into `website/assets/` again.
