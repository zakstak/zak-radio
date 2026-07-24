package application

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	packageDirectory, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(packageDirectory, "..", ".."))
	if err := os.Chdir(repositoryRoot); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.Chdir(packageDirectory)
	os.Exit(code)
}
