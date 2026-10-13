# QR Label Studio

A small frontend-only QR label generator and label library. It runs in the browser and does not require a backend or account.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- A current Chrome, Edge, Firefox, or Safari browser

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`).

## Production build

```bash
npm run build
npm run preview
```

The production site is written to `dist/`. The `dist/` folder can be deployed to static hosting such as GitHub Pages, Netlify, or Cloudflare Pages. For GitHub Pages under a repository subpath, set Vite's `base` option in `vite.config.js` to `'/repository-name/'` before building.

## Features

- Create QR labels from URLs, plain text, or identifiers.
- Upload one PNG logo and reuse it for future labels in this browser.
- Store saved labels in IndexedDB; each label keeps its own logo copy so replacing the default logo does not change old labels.
- Preview labels and export print-sized PNG files at approximately 300 pixels per inch for the selected sticker width.
- Search, edit, delete, and select saved labels.
- Export selected labels as a ZIP archive with one PNG per label.
- Export/import a JSON library backup, including the default logo and labels.
- No server, account, or remote database.

## Local storage notes

Saved labels and logos remain in the current browser profile on this device. Clearing site data can erase them. Use **Export backup** in the library to keep a backup. The app does not upload label content or logo files to a server.

## Logo / QR notes

- The app accepts PNG logo files up to 5 MB.
- High QR error correction (H) is used when encoding; test printed labels with the intended scanner and printer.
- The PNG is rendered at 300 pixels per inch and includes PNG resolution metadata for the configured sticker width. Confirm the print dialog uses the intended physical size, because some printer software ignores embedded resolution metadata.
