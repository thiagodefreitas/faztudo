// Command faztudo runs the faztudo daemon and its command line tools.
package main

import (
	"fmt"
	"os"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println("faztudo", version)
		return
	}
	fmt.Fprintln(os.Stderr, "faztudo: nothing here yet; see https://github.com/thiagodefreitas/faztudo")
	os.Exit(2)
}
