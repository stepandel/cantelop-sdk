package main

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/stepandel/cantelop/fire-fuse/workspacesync"
)

func TestAdapterLifetimeAndAuthentication(t *testing.T) {
	directory, state := t.TempDir(), t.TempDir()
	id := "wsp_11111111111111111111111111111111"
	input, parent := io.Pipe()
	output, handshake := io.Pipe()
	t.Cleanup(func() { parent.Close(); output.Close() })
	done := make(chan error, 1)
	go func() {
		done <- runSyncFiles([]string{"--directory", directory, "--workspace", id, "--state-directory", state}, input, handshake)
		handshake.Close()
	}()
	var hello struct{ Origin, Token, Directory string }
	if err := json.NewDecoder(output).Decode(&hello); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(hello.Origin + "/files?op=scan")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status: %d", response.StatusCode)
	}
	request, _ := http.NewRequest("GET", hello.Origin+"/files?op=scan", nil)
	request.Header.Set("Authorization", "Bearer "+hello.Token)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authenticated status: %d", response.StatusCode)
	}
	parent.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("adapter did not stop after parent EOF")
	}
	files, err := workspacesync.NewLocal(directory, id, state)
	if err != nil {
		t.Fatalf("directory lock was not released: %v", err)
	}
	files.Close()
}

func TestAdapterRejectsInvalidArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"internal-sync-files"}, {"--directory", "."}, {"--unknown"}} {
		if err := runSyncFiles(args, nil, io.Discard); err == nil {
			t.Fatalf("accepted invalid arguments: %v", args)
		}
	}
}
