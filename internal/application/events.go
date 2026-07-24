package application

import appevents "zak-radio-apphost/internal/events"

type Broadcaster = appevents.Broadcaster

func NewBroadcaster() *Broadcaster {
	return appevents.NewBroadcaster()
}
