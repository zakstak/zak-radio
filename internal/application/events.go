package application

import appevents "zak-radio/internal/events"

type Broadcaster = appevents.Broadcaster

func NewBroadcaster() *Broadcaster {
	return appevents.NewBroadcaster()
}
