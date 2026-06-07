package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const version = "0.1.0"

type command struct {
	name        string
	description string
	run         func([]string) error
}

var commands = []command{
	{"render-markdown", "Render Markdown from stdin or a file as ANSI terminal output", runRenderMarkdown},
	{"highlight-code", "Syntax-highlight code from stdin or a file as ANSI terminal output", runHighlightCode},
	{"git-summary", "Print a read-only JSON summary of a Git repository", runGitSummary},
	{"sysinfo", "Print a JSON summary of local CPU, memory, disk, and process usage", runSysinfo},
	{"fuzzy-rank", "Rank newline-delimited items with fuzzy matching", runFuzzyRank},
	{"pick", "Open an optional Bubble Tea picker for newline-delimited items", runPick},
}

func main() {
	if len(os.Args) < 2 {
		printUsage(os.Stderr)
		os.Exit(2)
	}

	name := os.Args[1]
	if name == "help" || name == "--help" || name == "-h" {
		printUsage(os.Stdout)
		return
	}
	if name == "version" || name == "--version" {
		fmt.Println(version)
		return
	}

	for _, cmd := range commands {
		if cmd.name == name {
			if err := cmd.run(os.Args[2:]); err != nil {
				fmt.Fprintf(os.Stderr, "tau-tools %s: %v\n", cmd.name, err)
				os.Exit(1)
			}
			return
		}
	}

	fmt.Fprintf(os.Stderr, "unknown command %q\n\n", name)
	printUsage(os.Stderr)
	os.Exit(2)
}

func printUsage(w io.Writer) {
	fmt.Fprintf(w, "tau-tools %s\n\n", version)
	fmt.Fprintln(w, "Optional native helpers for Tau. These commands are not invoked by Tau unless wired explicitly.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  tau-tools <command> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	for _, cmd := range commands {
		fmt.Fprintf(w, "  %-16s %s\n", cmd.name, cmd.description)
	}
}

func readInput(path string) (string, error) {
	var data []byte
	var err error
	if path != "" {
		data, err = os.ReadFile(path)
	} else {
		data, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func readLines(path string) ([]string, error) {
	input, err := readInput(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(input, "\r\n", "\n"), "\n")
	items := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		items = append(items, line)
	}
	return items, nil
}

func writeJSON(value any, pretty bool) error {
	var data []byte
	var err error
	if pretty {
		data, err = json.MarshalIndent(value, "", "  ")
	} else {
		data, err = json.Marshal(value)
	}
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(append(data, '\n'))
	return err
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

func requireNonEmpty(value, name string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", name)
	}
	return nil
}

func stdinIsTerminal() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (info.Mode() & os.ModeCharDevice) != 0
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return err
	}
	return nil
}
