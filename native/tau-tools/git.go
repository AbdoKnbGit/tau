package main

import (
	"errors"
	"flag"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

type gitSummary struct {
	Repository string         `json:"repository"`
	Head       *gitHead       `json:"head,omitempty"`
	Branches   []string       `json:"branches"`
	Recent     []gitCommit    `json:"recent"`
	Status     []gitFileState `json:"status,omitempty"`
}

type gitHead struct {
	Branch  string    `json:"branch,omitempty"`
	Hash    string    `json:"hash"`
	Short   string    `json:"short"`
	Message string    `json:"message"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

type gitCommit struct {
	Hash    string    `json:"hash"`
	Short   string    `json:"short"`
	Message string    `json:"message"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

type gitFileState struct {
	Path      string `json:"path"`
	Worktree  string `json:"worktree"`
	Staging   string `json:"staging"`
	ExtraPath string `json:"extraPath,omitempty"`
}

func runGitSummary(args []string) error {
	fs := newFlagSet("git-summary")
	repoPath := fs.String("repo", ".", "Repository path")
	limit := fs.Int("commits", 8, "Maximum recent commits to include")
	pretty := fs.Bool("pretty", false, "Pretty-print JSON")
	includeStatus := fs.Bool("status", true, "Include worktree status")

	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *limit < 0 {
		*limit = 0
	}

	repo, err := git.PlainOpenWithOptions(*repoPath, &git.PlainOpenOptions{
		DetectDotGit: true,
	})
	if err != nil {
		return err
	}

	summary := gitSummary{
		Repository: *repoPath,
		Branches:   []string{},
		Recent:     []gitCommit{},
	}

	headRef, err := repo.Head()
	if err == nil {
		commit, commitErr := repo.CommitObject(headRef.Hash())
		if commitErr == nil {
			summary.Head = commitToHead(headRef, commit)
		}
	}

	branches, err := repo.Branches()
	if err == nil {
		err = branches.ForEach(func(ref *plumbing.Reference) error {
			summary.Branches = append(summary.Branches, ref.Name().Short())
			return nil
		})
		if err != nil {
			return err
		}
	}

	if headRef != nil && *limit > 0 {
		iter, err := repo.Log(&git.LogOptions{From: headRef.Hash()})
		if err == nil {
			count := 0
			err = iter.ForEach(func(commit *object.Commit) error {
				if count >= *limit {
					return stopeach{}
				}
				summary.Recent = append(summary.Recent, gitCommit{
					Hash:    commit.Hash.String(),
					Short:   commit.Hash.String()[:12],
					Message: commit.Message,
					Author:  commit.Author.Name,
					Date:    commit.Author.When,
				})
				count++
				return nil
			})
			var stop stopeach
			if err != nil && !errors.As(err, &stop) {
				return err
			}
		}
	}

	if *includeStatus {
		worktree, err := repo.Worktree()
		if err == nil {
			status, err := worktree.Status()
			if err != nil {
				return err
			}
			for path, state := range status {
				summary.Status = append(summary.Status, gitFileState{
					Path:      path,
					Worktree:  string(state.Worktree),
					Staging:   string(state.Staging),
					ExtraPath: state.Extra,
				})
			}
		}
	}

	return writeJSON(summary, *pretty)
}

type stopeach struct{}

func (stopeach) Error() string { return "stop iteration" }

func commitToHead(ref *plumbing.Reference, commit *object.Commit) *gitHead {
	branch := ""
	if ref.Name().IsBranch() {
		branch = ref.Name().Short()
	}
	hash := commit.Hash.String()
	return &gitHead{
		Branch:  branch,
		Hash:    hash,
		Short:   hash[:12],
		Message: commit.Message,
		Author:  commit.Author.Name,
		Date:    commit.Author.When,
	}
}
