package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if os.Getenv("FAKE_PRINT_ARGS") == "1" {
		for _, arg := range os.Args[1:] {
			fmt.Println(arg)
		}
	}
	if os.Getenv("FAKE_PRINT_CWD") == "1" {
		cwd, err := os.Getwd()
		if err != nil {
			panic(err)
		}
		fmt.Println(cwd)
	}
	if path := os.Getenv("FAKE_COUNT_FILE"); path != "" {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			panic(err)
		}
		f.WriteString("x")
		f.Close()
	}
	if path := os.Getenv("FAKE_WRITE_FILE"); path != "" {
		if err := os.WriteFile(path, []byte(os.Getenv("FAKE_WRITE_CONTENT")), 0600); err != nil {
			panic(err)
		}
	}
	if os.Getenv("FAKE_GRANDCHILD") == "1" {
		signal.Ignore(syscall.SIGTERM)
		for {
			time.Sleep(time.Second)
		}
	}
	if path := os.Getenv("FAKE_CHILD_PID_FILE"); path != "" {
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), "FAKE_GRANDCHILD=1", "FAKE_CHILD_PID_FILE=")
		if err := child.Start(); err != nil {
			panic(err)
		}
		os.WriteFile(path, []byte(strconv.Itoa(child.Process.Pid)), 0600)
	}
	if s := os.Getenv("FAKE_STDOUT"); s != "" {
		fmt.Println(s)
	}
	if s := os.Getenv("FAKE_LONG_LINE"); s != "" {
		n, _ := strconv.Atoi(s)
		fmt.Println(strings.Repeat("x", n))
	}
	if s := os.Getenv("FAKE_STDERR"); s != "" {
		fmt.Fprintln(os.Stderr, s)
	}
	if s := os.Getenv("FAKE_SLEEP_MS"); s != "" {
		n, _ := strconv.Atoi(s)
		time.Sleep(time.Duration(n) * time.Millisecond)
	}
	if s := os.Getenv("FAKE_EXIT"); s != "" {
		n, _ := strconv.Atoi(s)
		os.Exit(n)
	}
}
