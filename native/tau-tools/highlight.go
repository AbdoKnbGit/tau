package main

import (
	"errors"
	"flag"
	"os"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
)

func runHighlightCode(args []string) error {
	fs := newFlagSet("highlight-code")
	inputPath := fs.String("in", "", "Read code from this file instead of stdin")
	lang := fs.String("lang", "", "Lexer/language name; autodetects from --in when omitted")
	styleName := fs.String("style", "github-dark", "Chroma style name")
	formatterName := fs.String("formatter", "terminal256", "Chroma formatter name")

	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	input, err := readInput(*inputPath)
	if err != nil {
		return err
	}

	lexer := lexers.Get(*lang)
	if lexer == nil && *inputPath != "" {
		lexer = lexers.Match(*inputPath)
	}
	if lexer == nil {
		lexer = lexers.Analyse(input)
	}
	if lexer == nil {
		lexer = lexers.Fallback
	}
	lexer = chroma.Coalesce(lexer)

	formatter := formatters.Get(*formatterName)
	if formatter == nil {
		return errors.New("unknown formatter")
	}
	style := styles.Get(*styleName)
	if style == nil {
		style = styles.Fallback
	}

	iterator, err := lexer.Tokenise(nil, input)
	if err != nil {
		return err
	}
	return formatter.Format(os.Stdout, style, iterator)
}
