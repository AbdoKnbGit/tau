package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/sahilm/fuzzy"
)

func runFuzzyRank(args []string) error {
	fs := newFlagSet("fuzzy-rank")
	inputPath := fs.String("in", "", "Read newline-delimited items from this file instead of stdin")
	query := fs.String("query", "", "Fuzzy query")
	limit := fs.Int("limit", 20, "Maximum matches to print")
	jsonOutput := fs.Bool("json", false, "Print matches as JSON")
	pretty := fs.Bool("pretty", false, "Pretty-print JSON")

	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if err := requireNonEmpty(*query, "--query"); err != nil {
		return err
	}
	if *limit < 0 {
		*limit = 0
	}

	items, err := readLines(*inputPath)
	if err != nil {
		return err
	}

	matches := fuzzy.Find(*query, items)
	if *limit > 0 && len(matches) > *limit {
		matches = matches[:*limit]
	}

	if *jsonOutput {
		type match struct {
			Index          int    `json:"index"`
			String         string `json:"string"`
			Score          int    `json:"score"`
			MatchedIndexes []int  `json:"matchedIndexes"`
		}
		out := make([]match, 0, len(matches))
		for _, m := range matches {
			out = append(out, match{
				Index:          m.Index,
				String:         m.Str,
				Score:          m.Score,
				MatchedIndexes: m.MatchedIndexes,
			})
		}
		return writeJSON(out, *pretty)
	}

	for _, m := range matches {
		if _, err := fmt.Fprintln(os.Stdout, m.Str); err != nil {
			return err
		}
	}
	return nil
}
