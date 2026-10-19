package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/stepandel/cantelop/fire-fuse/workspacesync"
)

// This SDK-owned adapter inherits only local filesystem authority. It never
// loads account, App integration, or infrastructure credentials.
func main() {
	if err := runSyncFiles(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runSyncFiles(args []string, input io.Reader, output io.Writer) error {
	flags := flag.NewFlagSet("internal-sync-files", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("directory", "", "local directory")
	workspace := flags.String("workspace", "", "workspace identity")
	stateDirectory := flags.String("state-directory", "", "private SDK sync state directory")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *directory == "" || *workspace == "" || *stateDirectory == "" {
		return errors.New("invalid sync helper arguments")
	}
	files, err := workspacesync.NewLocal(*directory, *workspace, *stateDirectory)
	if err != nil {
		return err
	}
	defer files.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	var secret [32]byte
	if _, err = rand.Read(secret[:]); err != nil {
		return err
	}
	token := hex.EncodeToString(secret[:])
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		files.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	if err = json.NewEncoder(output).Encode(map[string]any{"protocolVersion": 1, "origin": "http://" + listener.Addr().String(), "token": token, "directory": files.Directory()}); err != nil {
		server.Close()
		return err
	}
	ended := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, input); close(ended) }()
	select {
	case <-ended:
	case err = <-done:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if shutdownErr := server.Shutdown(ctx); shutdownErr != nil {
		_ = server.Close()
		return shutdownErr
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
