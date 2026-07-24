package main

import (
	"log"

	"zak-radio-apphost/internal/application"
)

func main() {
	if err := application.Run(); err != nil {
		log.Fatal(err)
	}
}
