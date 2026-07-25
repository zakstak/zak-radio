package application

import appconfig "zak-radio/internal/config"

type Config = appconfig.Config

func defaultConfig() (Config, error) {
	return appconfig.Load()
}

func validateListenerConfig(cfg Config) error {
	return appconfig.ValidateListener(cfg)
}
