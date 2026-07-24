package application

import appconfig "zak-radio-apphost/internal/config"

type Config = appconfig.Config

var (
	packagedRoutingSealed  bool
	packagedAllowedHosts   string
	packagedAllowedOrigins string
	packagedTrustedProxies string
	packagedTrustedIngress string
)

func packagedRouting() appconfig.PackagedRouting {
	return appconfig.PackagedRouting{
		Sealed:         packagedRoutingSealed,
		AllowedHosts:   packagedAllowedHosts,
		AllowedOrigins: packagedAllowedOrigins,
		TrustedProxies: packagedTrustedProxies,
		TrustedIngress: packagedTrustedIngress,
	}
}

func defaultConfig() (Config, error) {
	return appconfig.Load(packagedRouting())
}

func validatePackagedRouting(cfg Config) error {
	return appconfig.ValidatePackagedRouting(cfg, packagedRouting())
}

func validateListenerConfig(cfg Config) error {
	return appconfig.ValidateListener(cfg)
}
