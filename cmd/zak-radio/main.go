package main

import (
	"log"

	"zak-radio/internal/application"
)

func main() {
	if err := application.Run(); err != nil {
		log.Fatal(err)
	}
}
