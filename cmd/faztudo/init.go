package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/templates"
)

// runInit creates the config files if they are missing. With --template it
// also fills lanes.toml with a starting organization, as long as lanes.toml
// holds nothing but comments.
func runInit(p config.Paths, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	name := fs.String("template", "", "starting organization: "+strings.Join(templates.Names(), ", "))
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("usage: faztudo init [--template %s]", strings.Join(templates.Names(), "|"))
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected init arguments")
	}
	body := ""
	if *name != "" {
		var err error
		if body, err = templates.Get(*name); err != nil {
			return err
		}
	}
	if err := config.WriteDefaults(p); err != nil {
		return err
	}
	if *name == "" || *name == "empty" {
		return nil
	}
	used, err := hasSettings(p.LanesFile)
	if err != nil {
		return err
	}
	if used {
		return fmt.Errorf("%s already has settings; move it away or edit it by hand, then run init again", p.LanesFile)
	}
	if err := os.WriteFile(p.LanesFile, []byte(body), 0600); err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote %s from the %s template; edit it, then run faztudo serve\n", p.LanesFile, *name)
	return nil
}

// hasSettings reports whether the file has any line that is not blank or a
// comment.
func hasSettings(path string) (bool, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" && !strings.HasPrefix(line, "#") {
			return true, nil
		}
	}
	return false, sc.Err()
}
