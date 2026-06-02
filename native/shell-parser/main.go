package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

type request struct {
	Command string `json:"command"`
}

type diagnostic struct {
	Message string `json:"message"`
	Line    uint   `json:"line,omitempty"`
	Column  uint   `json:"column,omitempty"`
	Offset  uint   `json:"offset,omitempty"`
}

type summary struct {
	CommandCount           int      `json:"commandCount"`
	FirstCommands          []string `json:"firstCommands"`
	Operators              []string `json:"operators"`
	HasCd                  bool     `json:"hasCd"`
	HasPipeline            bool     `json:"hasPipeline"`
	HasRedirect            bool     `json:"hasRedirect"`
	HasControlFlow         bool     `json:"hasControlFlow"`
	HasHeredoc             bool     `json:"hasHeredoc"`
	HasFunction            bool     `json:"hasFunction"`
	HasSubshell            bool     `json:"hasSubshell"`
	HasCommandSubstitution bool     `json:"hasCommandSubstitution"`
}

type response struct {
	OK          bool         `json:"ok"`
	Parser      string       `json:"parser"`
	Formatted   string       `json:"formatted,omitempty"`
	Diagnostics []diagnostic `json:"diagnostics,omitempty"`
	Summary     *summary     `json:"summary,omitempty"`
}

func main() {
	var req request
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 512*1024))
	if err != nil {
		write(response{OK: false, Parser: parserName(), Diagnostics: []diagnostic{{Message: err.Error()}}})
		os.Exit(1)
	}
	if err := json.Unmarshal(input, &req); err != nil {
		write(response{OK: false, Parser: parserName(), Diagnostics: []diagnostic{{Message: err.Error()}}})
		os.Exit(1)
	}

	parser := syntax.NewParser(syntax.Variant(syntax.LangBash))
	file, err := parser.Parse(strings.NewReader(req.Command), "")
	if err != nil {
		write(response{OK: false, Parser: parserName(), Diagnostics: diagnosticsFromError(err)})
		os.Exit(0)
	}

	formatted, formatErr := formatFile(file)
	if formatErr != nil {
		write(response{OK: false, Parser: parserName(), Diagnostics: []diagnostic{{Message: formatErr.Error()}}})
		os.Exit(0)
	}

	write(response{
		OK:        true,
		Parser:    parserName(),
		Formatted: strings.TrimRight(formatted, "\n"),
		Summary:   summarize(file),
	})
}

func parserName() string {
	return "mvdan.cc/sh/v3/syntax"
}

func write(resp response) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(resp); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func diagnosticsFromError(err error) []diagnostic {
	if parseErr, ok := err.(*syntax.ParseError); ok {
		pos := parseErr.Pos
		return []diagnostic{{
			Message: parseErr.Text,
			Line:    pos.Line(),
			Column:  pos.Col(),
			Offset:  pos.Offset(),
		}}
	}
	return []diagnostic{{Message: err.Error()}}
}

func formatFile(file *syntax.File) (string, error) {
	var buf bytes.Buffer
	printer := syntax.NewPrinter(syntax.Indent(2))
	if err := printer.Print(&buf, file); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func summarize(file *syntax.File) *summary {
	result := &summary{
		FirstCommands: []string{},
		Operators:     []string{},
	}
	seenCommands := map[string]bool{}
	seenOperators := map[string]bool{}

	addCommand := func(name string) {
		if name == "" {
			return
		}
		result.CommandCount++
		if len(result.FirstCommands) < 8 && !seenCommands[name] {
			result.FirstCommands = append(result.FirstCommands, name)
			seenCommands[name] = true
		}
		if name == "cd" {
			result.HasCd = true
		}
	}
	addOperator := func(op string) {
		if op == "" || seenOperators[op] {
			return
		}
		seenOperators[op] = true
		result.Operators = append(result.Operators, op)
	}

	syntax.Walk(file, func(node syntax.Node) bool {
		switch x := node.(type) {
		case *syntax.CallExpr:
			addCommand(callName(x))
		case *syntax.Stmt:
			if x.Background {
				addOperator("&")
			}
		case *syntax.BinaryCmd:
			if x.Op == syntax.Pipe || x.Op == syntax.PipeAll {
				result.HasPipeline = true
			} else {
				result.HasControlFlow = true
			}
			addOperator(binaryOperator(x.Op))
		case *syntax.Redirect:
			result.HasRedirect = true
			if x.Op == syntax.Hdoc || x.Op == syntax.DashHdoc || x.Op == syntax.WordHdoc {
				result.HasHeredoc = true
			}
		case *syntax.IfClause, *syntax.ForClause, *syntax.WhileClause, *syntax.CaseClause:
			result.HasControlFlow = true
		case *syntax.FuncDecl:
			result.HasFunction = true
		case *syntax.Subshell:
			result.HasSubshell = true
		case *syntax.CmdSubst:
			result.HasCommandSubstitution = true
		}
		return true
	})

	return result
}

func callName(call *syntax.CallExpr) string {
	if len(call.Args) == 0 {
		return ""
	}
	word := call.Args[0]
	if len(word.Parts) != 1 {
		return ""
	}
	if lit, ok := word.Parts[0].(*syntax.Lit); ok {
		return lit.Value
	}
	return ""
}

func binaryOperator(op syntax.BinCmdOperator) string {
	switch op {
	case syntax.AndStmt:
		return "&&"
	case syntax.OrStmt:
		return "||"
	case syntax.Pipe:
		return "|"
	case syntax.PipeAll:
		return "|&"
	default:
		return op.String()
	}
}
