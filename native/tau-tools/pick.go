package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"charm.land/bubbles/v2/list"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type pickItem string

func (i pickItem) FilterValue() string { return string(i) }
func (i pickItem) Title() string       { return string(i) }
func (i pickItem) Description() string { return "" }

type pickModel struct {
	list     list.Model
	selected string
	quitting bool
}

func newPickModel(title string, values []string, height int) pickModel {
	items := make([]list.Item, 0, len(values))
	for _, value := range values {
		items = append(items, pickItem(value))
	}
	l := list.New(items, list.NewDefaultDelegate(), 80, height)
	l.Title = title
	l.SetShowStatusBar(false)
	l.SetFilteringEnabled(true)
	l.Styles.Title = lipgloss.NewStyle().Bold(true)
	return pickModel{list: l}
}

func (m pickModel) Init() tea.Cmd {
	return nil
}

func (m pickModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			m.quitting = true
			return m, tea.Quit
		case "enter":
			if item, ok := m.list.SelectedItem().(pickItem); ok {
				m.selected = string(item)
			}
			m.quitting = true
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.list.SetSize(msg.Width, max(8, msg.Height-2))
	}

	var cmd tea.Cmd
	m.list, cmd = m.list.Update(msg)
	return m, cmd
}

func (m pickModel) View() tea.View {
	if m.quitting {
		return tea.NewView("")
	}
	return tea.NewView(m.list.View())
}

func runPick(args []string) error {
	fs := newFlagSet("pick")
	inputPath := fs.String("in", "", "Read newline-delimited items from this file")
	title := fs.String("title", "Select item", "Picker title")
	height := fs.Int("height", 18, "Initial picker height")

	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *inputPath == "" {
		return errors.New("--in is required for interactive picking; piping stdin would leave no terminal input for the picker")
	}

	items, err := readLines(*inputPath)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return errors.New("no items to pick")
	}

	program := tea.NewProgram(newPickModel(*title, items, *height))
	model, err := program.Run()
	if err != nil {
		return err
	}
	if result, ok := model.(pickModel); ok && result.selected != "" {
		_, err := fmt.Fprintln(os.Stdout, result.selected)
		return err
	}
	return nil
}
