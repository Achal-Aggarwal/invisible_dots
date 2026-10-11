//go:build linux

package agentd

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// localSocket serves the local handler on a unix socket, as the daemon does.
func localSocket(t *testing.T) (string, *Server) {
	t.Helper()
	return localSocketWith(t, Options{Home: t.TempDir()})
}

// localSocketWith is localSocket for a server with these options.
func localSocketWith(t *testing.T, opts Options) (string, *Server) {
	t.Helper()
	opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := New(opts)
	sock := filepath.Join(shortTempDir(t), "agentd.sock")
	ln, err := ListenUnix(sock)
	if err != nil {
		t.Fatal(err)
	}
	hs := NewHTTPServer(srv.LocalHandler(), nil)
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() { _ = hs.Close() })
	return sock, srv
}

func relay(t *testing.T, sock string, opts RelayOptions, stdin string) (int, string, string) {
	t.Helper()
	opts.Socket = sock
	var out, errOut bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var in io.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	code, err := RunRelay(ctx, opts, in, &out, &errOut)
	if err != nil {
		t.Fatal(err)
	}
	return code, out.String(), errOut.String()
}

func TestProcRunsAProgramWithItsOutputsAndExitCode(t *testing.T) {
	sock, srv := localSocket(t)
	code, out, errOut := relay(t, sock, RelayOptions{
		Argv: []string{"/bin/sh", "-c", `echo "out $FOO $(pwd)"; echo err >&2; exit 3`},
		Env:  map[string]string{"FOO": "bar"},
	}, "")
	if code != 3 || out != "out bar "+srv.opts.Home+"\n" || errOut != "err\n" {
		t.Fatalf("code %d, out %q, err %q", code, out, errOut)
	}
}

func TestProcPassesInputThroughAndEndsIt(t *testing.T) {
	sock, _ := localSocket(t)
	code, out, _ := relay(t, sock, RelayOptions{Argv: []string{"/bin/sh", "-c", "tr a-z A-Z"}}, "hello\n")
	if code != 0 || out != "HELLO\n" {
		t.Fatalf("code %d, out %q", code, out)
	}
}

func TestProcRunsOnATerminalOfTheAskedSize(t *testing.T) {
	sock, _ := localSocket(t)
	code, out, _ := relay(t, sock, RelayOptions{
		Argv: []string{"/bin/sh", "-c", `test -t 0 && echo tty; stty size; echo "$TERM"`},
		TTY:  &ProcTTY{Cols: 100, Rows: 30},
	}, "")
	out = strings.ReplaceAll(out, "\r", "")
	if code != 0 || out != "tty\n30 100\nxterm-256color\n" {
		t.Fatalf("code %d, out %q", code, out)
	}
}

func TestProcFollowsAResizeAndForwardsSignals(t *testing.T) {
	sock, _ := localSocket(t)
	resize := make(chan ProcTTY, 1)
	signals := make(chan syscall.Signal, 1)
	resize <- ProcTTY{Cols: 50, Rows: 10}
	// The program says "resized" once its terminal has the new size, and the signal is sent only then: it must reach
	// a program that is running, and it ends the program, which would otherwise sleep for 30 s.
	out := &signalWriter{want: "resized", seen: make(chan struct{})}
	go func() {
		<-out.seen
		signals <- syscall.SIGTERM
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	code, err := RunRelay(ctx, RelayOptions{
		Socket:  sock,
		Argv:    []string{"/bin/sh", "-c", `while [ "$(stty size)" != "10 50" ]; do sleep 0.05; done; echo resized; sleep 30`},
		TTY:     &ProcTTY{Cols: 80, Rows: 24},
		Resize:  resize,
		Signals: signals,
	}, nil, out, io.Discard)
	if err != nil {
		t.Fatalf("the relay failed (the resize never reached the terminal?): %v; output %q", err, out.String())
	}
	if code != 128+int(syscall.SIGTERM) {
		t.Errorf("code %d, want %d; output %q", code, 128+int(syscall.SIGTERM), out.String())
	}
}

// signalWriter keeps what is written to it and closes seen once it holds want.
type signalWriter struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	want string
	seen chan struct{}
	once sync.Once
}

func (w *signalWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n, err := w.buf.Write(p)
	if strings.Contains(w.buf.String(), w.want) {
		w.once.Do(func() { close(w.seen) })
	}
	return n, err
}

func (w *signalWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestProcDiesWithItsCaller(t *testing.T) {
	sock, _ := localSocket(t)
	procDiesWithItsCaller(t, sock, filepath.Join(t.TempDir(), "pid"))
}

// procDiesWithItsCaller runs a command that leaves a background child and writes its pid to pidFile, ends the
// caller and waits for the child to be gone: the whole process group goes with the connection.
func procDiesWithItsCaller(t *testing.T, sock, pidFile string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = RunRelay(ctx, RelayOptions{
			Socket: sock,
			Argv:   []string{"/bin/sh", "-c", `sleep 300 & echo $! > ` + pidFile + `; wait`},
		}, nil, io.Discard, io.Discard)
	}()
	var pid int
	for i := 0; i < 100 && pid == 0; i++ {
		time.Sleep(50 * time.Millisecond)
		if raw, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		}
	}
	if pid == 0 {
		t.Fatal("the command never started")
	}
	cancel()
	<-done
	for i := 0; i < 100; i++ {
		if syscall.Kill(pid, 0) != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the background child %d outlived the caller", pid)
}

func TestProcRefusesBadRequestsAndIsNotOnTheTCPPort(t *testing.T) {
	sock, _ := localSocket(t)
	_, err := RunRelay(context.Background(), RelayOptions{Socket: sock, Argv: []string{"/bin/true"}, Cwd: "nope/missing"},
		nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid_cwd") {
		t.Errorf("a missing cwd: %v", err)
	}
	_, err = RunRelay(context.Background(), RelayOptions{Socket: sock, Argv: []string{""}}, nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "invalid_body") {
		t.Errorf("an empty program: %v", err)
	}
	f := newFixture(t)
	resp := f.postJSON("/v1/proc", ProcRequest{Argv: []string{"/bin/true"}})
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("the TCP port answered %d to /v1/proc", resp.StatusCode)
	}
}

func TestProcAsksForTheProtocolSwitch(t *testing.T) {
	sock, _ := localSocket(t)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}
	resp, err := client.Post("http://agentd/v1/proc", "application/json", strings.NewReader(`{"argv":["/bin/true"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUpgradeRequired || resp.Header.Get("Upgrade") != ProcUpgradeProtocol {
		t.Errorf("status %d, upgrade %q", resp.StatusCode, resp.Header.Get("Upgrade"))
	}
}

func TestProcFindsTheProgramInThePATHItIsStartedWith(t *testing.T) {
	sock, _ := localSocket(t)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "smoke-tool"), []byte("#!/bin/sh\necho found-by-path\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "not-executable"), []byte("#!/bin/sh\necho no\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"PATH": bin + ":/usr/bin:/bin"}
	code, out, _ := relay(t, sock, RelayOptions{Argv: []string{"smoke-tool"}, Env: env}, "")
	if code != 0 || out != "found-by-path\n" {
		t.Fatalf("code %d, out %q", code, out)
	}
	// A file without the execute bit is not a program, and a name that is nowhere is refused, not run.
	for _, name := range []string{"not-executable", "no-such-tool"} {
		_, err := RunRelay(context.Background(), RelayOptions{Socket: sock, Argv: []string{name}, Env: env}, nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "executable file not found") {
			t.Errorf("%s: got %v", name, err)
		}
	}
}
