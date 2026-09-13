# Compact Vessel header

Zak Radio adopts Ballast’s single-row header: 52px on phones, 56px on larger
screens, Braille r identity and 44px navigation/app-menu targets. Product
identity remains accessible on narrow displays, connection updates retain their
live region, and the app menu remains available. Vendor Signal Stack tokens and
service-switcher source stay intact.

This includes the previously prepared shared product chrome, now rebased onto
the current dependency refresh, plus the compact product composition. The
separately uncommitted native music bridge is not included. Radio, Library and
Reader retain their existing player and state behavior.

Validation: `go test ./...`, `go vet ./...`, deterministic generated CSS, and
four browser checks covering all three destinations at 320/390/900/1440, mobile
station controls, focus/dialog geometry and Reader segment visibility.
Additional 320/390/1280 screenshots verify the app menu and no horizontal
overflow. The Braille mark was visually checked for all six dot positions after
correcting an inherited image-size constraint.

The live pre-update index, application JS, platform JS and stylesheet matched
canonical main. The release preserves the existing 147-file timed-lyrics bundle,
retained music/Reader/SQLite volume, host/origin restrictions and exact ingress
addresses. Deployment identity and rollback receipts are recorded after
publication; no printing, shared station action or personal-data edit is part of
header QA.
