# Interface glossary

One word for each thing in the Zak Radio interface. Use these in labels,
messages, and announcements.

## Stations

- **All songs**: the main, shared station.
- **Temporary station**: a queue you control that ends 24 hours after its last
  use. Not "queue station" or "temporary queue".
- **Hand-picked station**: a saved list of chosen songs. Not "list station".
- **Filter station**: a saved station that plays every song matching a search or
  filter. Not "saved search".
- **Just you tuned in** / **N tuned in**: station presence includes listeners
  with audio paused. The accessible note says "Includes listeners with audio
  paused."
- **Your stations**: the stations this browser or app can edit. Not "Saved
  stations".

## Actions

- **Listen live** / **Stop listening**: this device only. The one label for
  going back to Radio from a preview; not "Back to live".
- **Start and listen** / **Resume and listen**: the big button on a paused
  station this device controls. It starts the station and plays it here in one
  step; the note under it says who else that reaches ("resumes All songs for
  everyone", "starts it for you and anyone with the link"). While the station is
  paused, Shared controls keep a separate **Resume for everyone** button.
- Choosing a station while listening means "play this": a live station plays at
  once, a paused one this device controls starts with **Undo**, and one it
  doesn't control is waited for (**Listen when it starts**).
- **Listen when it starts** / **Stop waiting**: only for listen-only listeners.
  This device waits for a paused station and plays it as soon as its owner
  starts it.
- **Shared controls**: the group of station-wide controls on All songs. On Radio
  it comes after this device's own controls (Listen and the song's actions); the
  station name and **Change** stay at the top. On a station you made, the same
  group is titled **Your station** or **Your temporary station**, with "Anyone
  on Zak Radio can listen · only you can change it".
- **Listen-only · shared by its owner**: what a listener who can't control the
  station sees in that place, and how the station sheet begins.
- **Pause for everyone**, **Skip for everyone**, **Resume for everyone**:
  station-wide changes on every station you control. They live in Shared
  controls and the full player. Temporary stations use labeled transport icons
  on phones to keep all five actions in one row.
- Playback settings (**Playback order**, **Skip disliked**) change the station
  for everyone, so they confirm with **Undo** like Pause and Skip.
- **Shuffle** / **Repeat**: a temporary station's play order, labelled toggles
  that show when they're on.
- **Copy listen-only link**: share a station; people with it can listen but
  can’t change it.
- **Private edit link**: restores editing of a saved station in another browser,
  profile, or device. Always say that anyone with it can change or delete the
  station.
- **Add**: the song action that opens Add to station, at every width.
- **Preview**: play a song privately in Library. The player says "Preview" at
  every width.
- **Recently added**: songs added in the last six months, in the shelf, the
  filter chip, the list heading, and the filter station option. Not "Recent" or
  "Recent additions".
- **On Radio**: what Radio plays now and next, beside the songs in Library on
  wide screens.
- **Open**: show a Reader item. **Resume**: continue its narration where you
  left off.
- **Try again**: the only retry label.
- **Undo**: reverse the last change; it stays until your next action. Several
  deletes in a row stay undoable together.
- Notifications: only one with **Undo** stays until your next action. Every
  other notification, including **Try again** and ways back such as **Back to
  “All songs”**, leaves on its own after a few seconds (8 with an action) and
  waits while it’s pointed at or focused. Pages leave room for it, so it never
  covers their last controls.
- **Play from this paragraph**: the Reader control beside each paragraph.
- **You stopped here**: marks where an opened Reader item resumes. The item
  opens at its header; **Resume** goes to the mark and plays from there.
- **Text settings** ("Text"): Reader's text size, line spacing, and page (Dark,
  Sepia, Light), saved on this device.
- **Download original**: the source file of a Reader item.
- **Mark as finished** / **Mark as not finished**: Reader progress. Narration
  that reaches the end marks the item finished on its own.
- **Hide from Reader** / **Show in Reader again**: hides an item on this device;
  it stays under the **Hidden** filter.

## Adding songs and API access

- **Add song**: Library's button and dialog for uploading a song, at the top of
  Library at every width. The dialog's main button says **Add song** too.
- **Sign in to add songs**: what signed-out listeners see in its place. It loads
  the page again through the sign-in gateway. **Sign in again** opens a new tab
  instead, so an open form keeps what you entered.
- **You’re signed out**: the error heading for an action that needs a sign-in
  ("You’re signed out, so the song wasn’t added."). It offers **Sign in again**
  and **Try again**.
- **Show song**: finds a song in Library and puts focus on it. A finished upload
  says "“Harbor Lights” is now in Library." and one that is already there says
  "This song is already in Library as “Harbor Lights”."; both offer **Show
  song**.
- Limits use everyday units: "32 MB", "20 minutes", "about 60,000 characters".
  Not MiB, KiB, bytes, "UTF-8", or "MPEG-1 or MPEG-2 Layer III".
- **API access**: the dialog for upload keys. Say "agent", not "LLM"; a new key
  is named "Agent uploads" unless you change it.
- A new upload key is shown once. Closing before copying it asks "Close without
  copying?" with **Copy key** and **Close anyway**.
- **Revoke** asks in the key's row first: "Revoke “Agent uploads”, created Nov
  12? Agents using it stop working right away." with **Cancel** and **Revoke
  key**.
- Dates read "Dec 12, 2026", never "12/12/2026". A creation date in the current
  year may drop the year: "created Nov 12".

## Words

- **Song description**, not "prompt" or "production notes": the musical
  description only.
- **Creation details**: the raw settings a song was made with (persona, seed),
  folded away under the song description.
- A change that didn't go through says why with the error heading, then what
  didn't happen, and offers **Try again**: "Can’t reach Zak Radio, so the skip
  didn’t happen." The music keeps playing.
- **Offline**: this device has no network. **Having trouble**: Zak Radio
  answered with an error while the network works. **Can’t connect**: the device
  is online but Zak Radio doesn’t answer. **Reconnecting…**: a connection that
  was working dropped and is coming back.
- Error headings are the same in every view, with no final period: **You’re
  offline**, **Can’t reach Zak Radio**, **Zak Radio is having trouble**, **Too
  many requests right now**. Rate limits say when to try again ("Try again in 30
  seconds").
- Reader statuses use the filter names: **Ready**; **Not ready** with how far
  along ("Not ready · waiting to start", "Not ready · 2 of 5 narrated"); and
  **Needs attention** with why ("Needs attention · couldn’t read the page").
  Badges use the same first words.
- Station limits are said plainly: "You can keep up to 5 stations at once";
  never "slots".
- **Skipped early**, not "early skips".
- **Oldest added first** / **Newest added first**, not "In the order added" or
  "Newest first". Library starts at Newest added first (Best match while
  searching) and remembers the listener's choice.
- **Search songs and lyrics**: Library's search, at every width.
- **Playback position**: the progress bar or seek slider in every player (Radio,
  the dock, and the full player). Not "Song progress".
- **Fleet**, not "Saga Fleet".
- Apostrophes are curly (’) everywhere in the interface.
