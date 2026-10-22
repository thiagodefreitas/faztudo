package app

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type changedPath struct {
	name string
	// executable is true for anything but a plain file: an executable,
	// a symlink or a submodule.
	executable bool
}

func protectedApprovalPath(name string) bool {
	name = strings.TrimPrefix(name, "./")
	base := path.Base(name)
	if name == ".git" || strings.HasPrefix(name, ".git/") || name == ".github" || strings.HasPrefix(name, ".github/") || name == "scripts" || strings.HasPrefix(name, "scripts/") {
		return true
	}
	switch base {
	case ".gitlab-ci.yml", "lefthook.yml", ".pre-commit-config.yaml", "Makefile", "go.mod", "go.sum", "package.json", "package-lock.json", "Dockerfile", ".gitmodules":
		return true
	}
	return strings.HasSuffix(base, ".lock")
}

func approvalPathMatches(glob, name string) bool {
	if strings.HasSuffix(glob, "/**") {
		prefix := strings.TrimSuffix(glob, "**")
		return strings.HasPrefix(name, prefix) && len(name) > len(prefix)
	}
	ok, _ := path.Match(glob, name)
	return ok
}

func approvalRuleMatches(rule domain.ApprovalRule, run domain.Run, persona string, changed []changedPath) bool {
	if run.Mode != domain.RunWrite || run.ChannelID != rule.ChannelID || run.State != domain.RunWaitingApproval || run.Verification == nil || !run.Verification.OK || run.DiffStat == nil || len(changed) == 0 {
		return false
	}
	if rule.Persona != "" && rule.Persona != persona {
		return false
	}
	if run.DiffStat.Insertions+run.DiffStat.Deletions > rule.MaxLines {
		return false
	}
	for _, file := range changed {
		if file.executable || protectedApprovalPath(file.name) {
			return false
		}
		if len(rule.Paths) > 0 {
			matched := false
			for _, glob := range rule.Paths {
				if approvalPathMatches(glob, file.name) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
	}
	return true
}

// changedApprovalPaths inspects the worktree that will be merged. Raw diff
// records include old and new rename names and old/new modes.
func (a *App) changedApprovalPaths(ctx context.Context, run domain.Run) ([]changedPath, domain.DiffStat, error) {
	channel, err := a.Store.Channel(ctx, run.ChannelID)
	if err != nil {
		return nil, domain.DiffStat{}, err
	}
	wm := worktree.Manager{BaseDir: a.Paths.WorktreesDir}
	w, err := wm.Open(ctx, channel.RepoPath, run.Worktree, "fz/"+run.ID, run.BaseCommit)
	if err != nil {
		return nil, domain.DiffStat{}, err
	}
	stat, _, err := wm.Diff(ctx, w)
	if err != nil {
		return nil, domain.DiffStat{}, err
	}
	out, err := wm.Git(ctx, w, "diff", "--raw", "-z", "-M", run.BaseCommit, "--")
	if err != nil {
		return nil, domain.DiffStat{}, err
	}
	fields := strings.Split(strings.Trim(out, "\x00"), "\x00")
	var changed []changedPath
	for i := 0; i < len(fields) && fields[i] != ""; {
		meta := strings.Fields(fields[i])
		if len(meta) < 5 || i+1 >= len(fields) {
			return nil, domain.DiffStat{}, fmt.Errorf("invalid raw diff")
		}
		// Only plain files may pass a rule: a new executable bit, a symlink
		// or a submodule is a way to run or reach code outside the change.
		executable := meta[1] != "100644" && meta[1] != "000000"
		changed = append(changed, changedPath{name: fields[i+1], executable: executable})
		i += 2
		if strings.HasPrefix(meta[4], "R") || strings.HasPrefix(meta[4], "C") {
			if i >= len(fields) {
				return nil, domain.DiffStat{}, fmt.Errorf("invalid rename diff")
			}
			changed = append(changed, changedPath{name: fields[i], executable: executable})
			i++
		}
	}
	return changed, stat, nil
}

func (a *App) applyApprovalRule(ctx context.Context, run domain.Run, persona string, approvalID string) {
	rules, err := a.Store.ApprovalRules(ctx, run.ChannelID)
	if err != nil || len(rules) == 0 {
		return
	}
	changed, stat, err := a.changedApprovalPaths(ctx, run)
	if err != nil {
		a.notice(ctx, run.ChannelID, "warn", "Approval rule inspection failed: "+err.Error())
		return
	}
	run.DiffStat = &stat
	for _, rule := range rules {
		if !approvalRuleMatches(rule, run, persona, changed) {
			continue
		}
		approval, err := a.Store.Approval(ctx, approvalID)
		if err != nil || approval.State != domain.ApprovalPending {
			return
		}
		note, err := a.ResolveApproval(ctx, approval, "merge", "")
		if err == nil {
			_, err = a.Store.ResolveApproval(ctx, approval.ID, "merge", "Merged by rule "+rule.ID[:8]+". "+note, "system")
		}
		if err != nil {
			a.notice(ctx, run.ChannelID, "warn", "Rule "+rule.ID[:8]+" could not merge: "+err.Error()+". The approval is still pending.")
		} else {
			_, _ = a.Store.Append(ctx, events.Draft{Type: events.Notice, Actor: events.System, ChannelID: run.ChannelID, Payload: events.NoticePayload{Level: "info", Text: "Rule " + rule.ID[:8] + " merged this run.", Action: &events.NoticeAction{Kind: "approval_rule_remove", Label: "Remove rule", RuleID: rule.ID}}})
		}
		return
	}
}
