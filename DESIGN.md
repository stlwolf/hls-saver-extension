# Capture and export design

Implementation scope approved on 2026-11-20: preserve playback-only capture, manual ON/OFF and export, automatic document/tab cleanup. No segment refetching or automatic export.

## Storage and output decision

Independent, read-only design exploration was completed before implementation by the `design_review` agent in this session. It recommended extension-origin IndexedDB chunks and a dedicated export page, with the following alternatives:

| Option | Decision and reason | Validation |
|---|---|---|
| IndexedDB chunks, bounded JSON messages, file writer | Selected: few moving parts; export reads chunks directly from the same origin | Real IndexedDB transactions, extension messaging and sequential writes |
| Offscreen document and OPFS | Deferred: introduces another lifecycle and communication layer | Reconsider if measured IndexedDB throughput is insufficient |
| TransformStream in playback path | Rejected: storage backpressure can stall playback and replacing Response changes observable semantics | Slow-writer test must leave playback independent |
| CDP/debugger network capture | Deferred: broader coverage but extra permissions, attachment and body-retention constraints | Outside current capture scope |

The reviewer specifically identified clone tee buffering, stale document resurrection, snapshot boundaries, and user activation for file selection as risks. Chunk ACK alone does not bound Response.clone's internal tee buffer. Capture must drain without waiting on storage, cap outstanding bytes and concurrent bodies, cancel its branch on overload, and report loss. Export memory must be independent of total recording size. Browser-internal buffering is not promised to have a strict byte bound.

## Invariants

- A browser-run epoch is held in storage.session; service-worker restarts preserve it. Browser restart or extension reload invalidates previous epochs.
- Each top-level document has a session tied to sender.documentId. Current documents are verified with webNavigation.getFrame before registration.
- Lifecycle mutations and capture messages are serialized. Removing a session precedes releasing its data, so late chunks cannot recreate it.
- OFF rejects new begins; previously accepted record IDs can finish. A monotonically increasing capture generation rejects work from a previous ON period.
- Export freezes record IDs at creation and waits only for those records. New captures cannot change that export.
- Metadata is separate from binary chunks. Statistics never read binary data. Transactions are acknowledged after commit.
- Export supports one contiguous, unencrypted media playlist with a stable init segment and no discontinuity. Separate playlists are separate export choices. Missing internal segments, encryption, map changes and ambiguous ranges are errors, never silently concatenated.
- Export is user initiated on a dedicated extension page. Saving uses a sequential File System Access writer, with success only after close. No large Blob/DataURL fallback.
- Navigation, explicit Clear and tab closure invalidate exports. Existing completed output files remain untouched.
- The old HLSSaverDB is preserved on upgrade because it has no trustworthy session ownership; the README explains how to release legacy data using the old version's Clear before upgrade.

## Verification gates

- Capture: playback response semantics, ON/OFF generations, bounded pending bytes, XHR modes, failed writes.
- Storage: commit acknowledgement, snapshot isolation, startup cleanup, stale chunks, independent tabs, worker restart.
- Export: playlist ordering, rolling playlists, byte ranges, missing segments, TS/fMP4, cancellation, writer failures and lifecycle invalidation.
- Browser: real extension and IndexedDB smoke tests, file-writer activation, capture/export memory behavior. Any unavailable check must be disclosed.

## Verification results (2026-11-20)

- 17 Node tests passed: playback delivery independent of storage, OFF/ON generations, queue overload, XHR text/Blob/reuse, HLS ordering/ranges/updates/unsupported inputs, transaction deletion, snapshot boundary, document/SPA invalidation and browser epoch recovery.
- Chromium 145.0.7632.6 loaded the actual MV3 extension in a temporary profile. Both TS and fMP4 capture/export produced files that ffprobe identified as 3-second videos. Request counts confirmed no extension refetches.
- A 64.4 MiB recording was captured and exported with writes no larger than 196608 bytes. After explicit GC, retained JS heap increased by approximately 0.0 MiB in the capture page and 0.5 MiB in the export page. This is not a measurement or guarantee of total browser memory.
- Real-browser tests also passed OFF behavior, picker cancellation, writer failure, reload cleanup, SPA cleanup and tab-close cleanup, with no uncaught page errors.
- Save-file selection was replaced in automation with an OPFS file handle; writes used the actual native FileSystemWritableFileStream. User activation at the picker invocation was verified. The OS save dialog and the user's target website have not been manually tested.
- Review found and corrected missing state-application acknowledgement, an overly low active-capture limit for short fMP4 segments, reused-XHR listeners, quadratic merge lookups, hidden control errors, and absent startup/SPA lifecycle listeners. No remaining critical findings were identified in the final local diff review.

## Copilot review follow-up

The first Copilot review identified six additional defects. The correction tracks discontinuity sequence numbers across rolling windows, explicitly rejects EXT-X-SKIP delta playlists, rotates sessions on hash navigation, preserves both requested and final URLs, excludes HEAD XHR, and validates media headers across chunk boundaries. Requested URLs identify captured segments; final playlist URLs resolve relative references. Format validation reads at most 189 prefix bytes instead of assuming the first network chunk contains a complete header.

Regression tests cover each finding, including redirected fetch and XHR separately. Browser fixtures redirect playlists and segments, split an fMP4 init header after four bytes, and exercise HEAD and hash navigation. Review corrections are tested before requesting the next review.

The second Copilot review confirmed those six fixes and reported five new issues. The next correction distinguishes initialization from explicit OFF, retains startup candidates within the existing 8 MiB queue budget for at most 10 seconds, and resolves relative request URLs against document.baseURI when the request starts. Playlist versions are folded one at a time into per-playlist sequence metadata; raw decoded histories are released and parse errors stay local to the affected playlist. TS records must contain a positive integral number of 188-byte packets before export.

All 35 Node tests passed. Real-browser regression tests deliberately delayed registration while inline playback requested its playlist and first segment, rejected a one-byte TS without publishing output, and allowed supported video output alongside unsupported alternate playlists. A 32+ MiB repeated playlist history used approximately 2.5 MiB of retained export-page JS heap after collection; the 64.4 MiB media export still used writes no larger than 192 KiB. These measurements describe retained JS heap in this fixture, not total browser memory. No additional media requests were introduced.
