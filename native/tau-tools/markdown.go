package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/ansi"
)

var (
	ansiPattern              = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	trailingAnsiSpacePattern = regexp.MustCompile(`(?:(?:\x1b\[[0-?]*[ -/]*[@-~])*[ \t]+(?:\x1b\[[0-?]*[ -/]*[@-~])*)+$`)
)

func runRenderMarkdown(args []string) error {
	fs := newFlagSet("render-markdown")
	inputPath := fs.String("in", "", "Read Markdown from this file instead of stdin")
	style := fs.String("style", "tau-compact-dark", "Glamour style name, Tau compact style, or style file path")
	width := fs.Int("width", 100, "Word-wrap width")

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

	options := []glamour.TermRendererOption{
		markdownStyleOption(*style),
		glamour.WithWordWrap(*width),
		glamour.WithTableWrap(false),
	}
	renderer, err := glamour.NewTermRenderer(options...)
	if err != nil {
		return err
	}
	defer renderer.Close()

	output, err := renderer.Render(input)
	if err != nil {
		return err
	}
	output = compactRenderedMarkdown(output)
	if _, err := fmt.Fprint(os.Stdout, output); err != nil {
		return err
	}
	return nil
}

func compactRenderedMarkdown(output string) string {
	output = strings.ReplaceAll(output, "\r\n", "\n")
	output = strings.ReplaceAll(output, "\r", "\n")
	output = strings.ReplaceAll(output, "\ufeff", "")
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		lines[i] = trimRenderedLine(line)
	}

	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[0])) == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && strings.TrimSpace(stripANSI(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}

	compact := make([]string, 0, len(lines))
	for _, line := range lines {
		blank := strings.TrimSpace(stripANSI(line)) == ""
		if blank {
			if len(compact) > 0 && compact[len(compact)-1] != "" {
				compact = append(compact, "")
			}
			continue
		}
		compact = append(compact, line)
	}
	return strings.Join(compact, "\n")
}

func trimRenderedLine(line string) string {
	trimmed := strings.TrimRight(line, " \t")
	for {
		next := trailingAnsiSpacePattern.ReplaceAllString(trimmed, "")
		if next == trimmed {
			return trimmed
		}
		trimmed = next
	}
}

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}

func markdownStyleOption(style string) glamour.TermRendererOption {
	switch style {
	case "tau-compact", "tau-compact-dark":
		return glamour.WithStyles(compactMarkdownStyle(false))
	case "tau-compact-light":
		return glamour.WithStyles(compactMarkdownStyle(true))
	default:
		return glamour.WithStylePath(style)
	}
}

func compactMarkdownStyle(light bool) ansi.StyleConfig {
	text := "252"
	heading := "81"
	muted := "244"
	link := "45"
	code := "203"
	codeBg := "236"
	if light {
		text = "238"
		heading = "25"
		muted = "243"
		link = "26"
		code = "161"
		codeBg = "255"
	}
	bold := true
	italic := true
	return ansi.StyleConfig{
		Document: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Color: &text},
			Margin:         uintPtr(0),
		},
		BlockQuote: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Color: &muted},
			Indent:         uintPtr(0),
			IndentToken:    stringPtr("> "),
		},
		List: ansi.StyleList{
			LevelIndent: 2,
		},
		Heading: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				BlockSuffix: "\n",
				Color:       &heading,
				Bold:        &bold,
			},
		},
		H1: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "# "},
		},
		H2: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "## "},
		},
		H3: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "### "},
		},
		H4: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "#### "},
		},
		H5: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "##### "},
		},
		H6: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Prefix: "###### "},
		},
		Emph: ansi.StylePrimitive{
			Italic: &italic,
		},
		Strong: ansi.StylePrimitive{
			Bold: &bold,
		},
		HorizontalRule: ansi.StylePrimitive{
			Color:  &muted,
			Format: "\n--------\n",
		},
		Item: ansi.StylePrimitive{
			BlockPrefix: "- ",
		},
		Enumeration: ansi.StylePrimitive{
			BlockPrefix: ". ",
		},
		Task: ansi.StyleTask{
			Ticked:   "[x] ",
			Unticked: "[ ] ",
		},
		Link: ansi.StylePrimitive{
			Color:     &link,
			Underline: &bold,
		},
		LinkText: ansi.StylePrimitive{
			Color: &link,
			Bold:  &bold,
		},
		Code: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix:          "`",
				Suffix:          "`",
				Color:           &code,
				BackgroundColor: &codeBg,
			},
		},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{
				Margin: uintPtr(0),
			},
			Theme: "github-dark",
		},
		Table: ansi.StyleTable{
			CenterSeparator: stringPtr("|"),
			ColumnSeparator: stringPtr("|"),
			RowSeparator:    stringPtr("-"),
		},
	}
}

func uintPtr(value uint) *uint {
	return &value
}

func stringPtr(value string) *string {
	return &value
}
