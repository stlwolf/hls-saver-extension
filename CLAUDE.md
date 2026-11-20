# HLS Stream Saver

This is a vanilla-JavaScript Chrome MV3 extension. Read README.md for user behavior, supported merge formats, storage lifetime, and verification commands. DESIGN.md records the approved scope and design alternatives.

## Components

- `content-main.js`: page-world fetch/XHR wrappers; copies successful playback responses, never refetches or waits on storage before returning playback responses. Generation checks gate capture, and queue limits fail visibly.
- `content-isolated.js`: allowlisted MAIN-to-extension message bridge and acknowledged capture-state changes.
- `background.js`: serialized lifecycle/capture/control lane, browser epoch, document validation, session cleanup and immutable export snapshots.
- `storage.js`: extension-origin IndexedDB sessions, record metadata, binary chunks and exports. Mutations acknowledge transaction commit. Shared by worker and export page.
- `playlist.js`: conservative HLS merge planning without network access.
- `media.js`: bounded TS/fMP4 header validation across arbitrary stored chunk boundaries.
- `export.html` / `export.js`: stable snapshot, explicit playlist choice, sequential File System Access writes, cancellation and source-session invalidation.
- `popup.html` / `popup.js`: active-tab capture controls and metadata-only stats.
- `ui.css`: shared UI styles.
- `tests/`: Node tests with fake-indexeddb and isolated real-browser verification.

## Invariants

Never add segment re-requests. Do not couple playback response delivery to storage completion. Do not introduce getAll of binary bodies, whole-recording arrays, Blob or DataURL export. Preserve tab/document ownership checks, state acknowledgements, immutable snapshot IDs, and atomic deletion. Never infer segment order from request arrival or filenames. Unsupported or incomplete media must be visible, not silently exported as a complete recording.

The original `HLSSaverDB` remains untouched for upgrade safety; only the new `HLSSaverCaptureDB` participates in automatic cleanup. Do not modify the user's untracked `scripts/` or `.DS_Store` as part of unrelated work.

## Verification

Use Node >=20. `npm test` checks merge planning, IndexedDB operations, capture boundaries and lifecycle races. `npm run test:browser` needs Chromium, ffmpeg and ffprobe; it uses a disposable browser profile. File selection is substituted with a real OPFS handle in automation, so the native OS picker still needs a manual smoke check.
