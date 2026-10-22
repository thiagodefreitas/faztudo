package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func parseCompareRequest(body, handle string) (string, bool) {
	re := regexp.MustCompile(`(?i)(^|[^A-Za-z0-9])(@` + regexp.QuoteMeta(handle) + `)\s+x2(?:\s+|$)`)
	loc := re.FindStringSubmatchIndex(body)
	if loc == nil {
		return body, false
	}
	return body[:loc[5]] + " " + body[loc[1]:], true
}

func (a *App) startCompare(ctx context.Context, m domain.Message, agent domain.Member) error {
	if strings.HasSuffix(strings.ToLower(strings.TrimSpace(m.Body)), "@"+strings.ToLower(agent.Handle)) {
		return fmt.Errorf("@%s x2 needs a request; no run started", agent.Handle)
	}
	if agent.Agent == nil || agent.Agent.Mode != domain.RunWrite {
		return fmt.Errorf("@%s x2 needs a write persona; no run started", agent.Handle)
	}
	channel, err := a.Store.Channel(ctx, m.ChannelID)
	if err != nil {
		return err
	}
	if channel.RepoPath == "" {
		return errors.New("x2 needs a channel repository; no run started")
	}
	var chosen [2]string
	var reasons []string
	count := 0
	for _, id := range agent.Agent.Lanes {
		if err := a.syncManualLane(ctx, id); err != nil {
			return err
		}
		lane, ok := a.Registry.Snapshot(id)
		if !ok {
			reasons = append(reasons, id+" is unknown")
		} else if lane.Health == domain.LaneConserve || lane.Health == domain.LaneExhausted || lane.Health == domain.LaneUnavailable {
			reasons = append(reasons, id+" is "+string(lane.Health))
		} else if lane.Running >= lane.Capacity {
			reasons = append(reasons, id+" is busy")
		} else {
			chosen[count] = id
			count++
			if count == 2 {
				break
			}
		}
	}
	if count < 2 {
		if len(reasons) == 0 {
			reasons = append(reasons, "the persona has fewer than two lanes in its chain")
		}
		return fmt.Errorf("@%s x2 needs two healthy lanes; found %d. %s. No run started", agent.Handle, count, strings.Join(reasons, "; "))
	}
	prompt, sections, err := a.promptPartsForRun(ctx, m, "", domain.RunWrite, agent.Handle)
	if err != nil {
		return err
	}
	group := events.CompareStartedPayload{ID: store.NewID(), ChannelID: m.ChannelID, MessageID: m.ID, AgentID: agent.ID, Lanes: chosen}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.CompareStarted, Actor: events.System, ChannelID: m.ChannelID, Payload: group}); err != nil {
		return err
	}
	for _, id := range chosen {
		laneID := id
		go func() {
			var err error
			if a.compareDispatch != nil {
				err = a.compareDispatch(context.Background(), m, agent, laneID)
			} else {
				err = a.attempt(context.Background(), m, agent, laneID, "", new(string), true, prompt, sections)
			}
			if err != nil {
				a.notice(context.Background(), m.ChannelID, "error", fmt.Sprintf("x2 candidate on %s failed: %v", laneID, err))
			}
		}()
	}
	return nil
}

func (a *App) CompareList(ctx context.Context, channelID string) ([]api.CompareGroup, error) {
	runs, err := a.Store.Runs(ctx, channelID, "")
	if err != nil {
		return nil, err
	}
	groups := []api.CompareGroup{}
	index := map[string]int{}
	batch, err := a.Store.EventsOfTypes(ctx, channelID, events.CompareStarted, events.CompareDecided)
	if err != nil {
		return nil, err
	}
	for _, event := range batch {
		switch event.Type {
		case events.CompareStarted:
			var p events.CompareStartedPayload
			if json.Unmarshal(event.Payload, &p) == nil && p.ChannelID == channelID {
				index[p.ID] = len(groups)
				groups = append(groups, api.CompareGroup{ID: p.ID, ChannelID: p.ChannelID, MessageID: p.MessageID, AgentID: p.AgentID, Candidates: [2]api.CompareCandidate{{LaneID: p.Lanes[0]}, {LaneID: p.Lanes[1]}}})
			}
		case events.CompareDecided:
			var p events.CompareDecidedPayload
			if json.Unmarshal(event.Payload, &p) == nil {
				if i, ok := index[p.ID]; ok {
					groups[i].Decision = p.Decision
					groups[i].WinnerLane = p.WinnerLane
					groups[i].CombineMessageID = p.CombineMessageID
				}
			}
		}
	}
	for i := range groups {
		for j := range groups[i].Candidates {
			for k := range runs {
				run := runs[k]
				if run.TriggerMessageID == groups[i].MessageID && run.LaneID == groups[i].Candidates[j].LaneID {
					groups[i].Candidates[j].Run = &run
					if !compareFinished(&run) {
						break
					}
					if cached, ok := a.compareTails.Load(run.ID); ok {
						groups[i].Candidates[j].OutputTail = cached.([]string)
						break
					}
					lines, err := a.Store.RunOutput(ctx, run.ID, 0)
					if err != nil {
						return nil, err
					}
					if len(lines) > 3 {
						lines = lines[len(lines)-3:]
					}
					for _, line := range lines {
						text := line.Text
						if len(text) > 400 {
							text = text[len(text)-400:]
						}
						groups[i].Candidates[j].OutputTail = append(groups[i].Candidates[j].OutputTail, text)
					}
					a.compareTails.Store(run.ID, groups[i].Candidates[j].OutputTail)
					break
				}
			}
		}
	}
	return groups, nil
}

func compareFinished(run *domain.Run) bool {
	return run != nil && (run.State == domain.RunWaitingApproval || run.State.Terminal())
}

// A crash after compare.started but before run.created must not leave the
// compare card waiting for a candidate that will never appear.
func (a *App) recoverCompares(ctx context.Context) error {
	channels, err := a.Store.Channels(ctx)
	if err != nil {
		return err
	}
	for _, channel := range channels {
		groups, err := a.CompareList(ctx, channel.ID)
		if err != nil {
			return err
		}
		for _, group := range groups {
			if group.Decision != "" {
				continue
			}
			for _, candidate := range group.Candidates {
				if candidate.Run != nil {
					continue
				}
				now := time.Now().UTC()
				run := domain.Run{ID: store.NewID(), ChannelID: channel.ID, TriggerMessageID: group.MessageID, AgentID: group.AgentID, LaneID: candidate.LaneID, Mode: domain.RunWrite, State: domain.RunFailed, FailureReason: "daemon stopped before the candidate started", EndedAt: &now}
				if _, err := a.Store.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run}); err != nil {
					return err
				}
				a.notice(ctx, channel.ID, "warn", "x2 candidate on "+candidate.LaneID+" did not start before the daemon restarted.")
			}
		}
	}
	return nil
}

func (a *App) CompareDecide(ctx context.Context, channelID, id, decision, humanID string) (api.CompareGroup, error) {
	a.compareMu.Lock()
	defer a.compareMu.Unlock()
	groups, err := a.CompareList(ctx, channelID)
	if err != nil {
		return api.CompareGroup{}, err
	}
	var group *api.CompareGroup
	for i := range groups {
		if groups[i].ID == id {
			group = &groups[i]
			break
		}
	}
	if group == nil {
		return api.CompareGroup{}, store.ErrNotFound
	}
	if group.Decision == "combine" && decision == "combine" && group.CombineMessageID != "" {
		// A crash or a failed step left the combiner unstarted: finish it
		// once, without a second combine message or run.
		if err := a.combineCompare(ctx, *group, humanID, group.CombineMessageID); err != nil {
			return api.CompareGroup{}, err
		}
		return *group, nil
	}
	if group.Decision != "" {
		return api.CompareGroup{}, domain.UserError{Message: "This comparison was already decided."}
	}
	left, right := group.Candidates[0].Run, group.Candidates[1].Run
	if !compareFinished(left) || !compareFinished(right) {
		return api.CompareGroup{}, domain.UserError{Message: "Both candidates must finish before choosing."}
	}
	wanted := [2]string{"discard", "discard"}
	if decision == "merge_a" {
		wanted[0] = "merge"
	} else if decision == "merge_b" {
		wanted[1] = "merge"
	}
	for i, run := range [2]*domain.Run{left, right} {
		if run.ApprovalOption != "" && run.ApprovalOption != wanted[i] {
			return api.CompareGroup{}, domain.UserError{Message: "This comparison was partly decided already; retry the original choice."}
		}
	}
	resolve := func(run *domain.Run, option string) error {
		if option == "discard" {
			return a.discardCompareRun(ctx, run)
		}
		if run.State != domain.RunWaitingApproval {
			return nil
		}
		approval := domain.Approval{RunID: run.ID, ChannelID: channelID, CommitMessage: a.commitMessage(ctx, *run)}
		_, err := a.ResolveApproval(ctx, approval, option, "")
		return err
	}
	var winner *domain.Run
	switch decision {
	case "merge_a", "merge_b":
		var loser *domain.Run
		winner, loser = left, right
		if decision == "merge_b" {
			winner, loser = right, left
		}
		if (winner.State != domain.RunWaitingApproval && !(winner.State == domain.RunDone && winner.ApprovalOption == "merge")) || winner.DiffStat == nil || winner.DiffStat.Files == 0 {
			return api.CompareGroup{}, domain.UserError{Message: "The chosen candidate has no changes to merge."}
		}
		if err := resolve(winner, "merge"); err != nil {
			return api.CompareGroup{}, err
		}
		if err := resolve(loser, "discard"); err != nil {
			return api.CompareGroup{}, err
		}
	case "discard_both":
		if err := resolve(left, "discard"); err != nil {
			return api.CompareGroup{}, err
		}
		if err := resolve(right, "discard"); err != nil {
			return api.CompareGroup{}, err
		}
	case "combine":
		// The decision is recorded before the combiner starts, so a second
		// click after a crash retries this one instead of starting another.
		if _, _, err := a.combineInputs(ctx, *group); err != nil {
			return api.CompareGroup{}, err
		}
		messageID := store.NewID()
		payload := events.CompareDecidedPayload{ID: id, Decision: decision, By: humanID, CombineMessageID: messageID}
		if _, err := a.Store.Append(ctx, events.Draft{Type: events.CompareDecided, Actor: events.Human(humanID), ChannelID: channelID, Payload: payload, IdempotencyKey: "compare:" + id}); err != nil {
			return api.CompareGroup{}, err
		}
		group.Decision, group.CombineMessageID = decision, messageID
		if err := a.combineCompare(ctx, *group, humanID, messageID); err != nil {
			return api.CompareGroup{}, err
		}
		return *group, nil
	default:
		return api.CompareGroup{}, domain.UserError{Message: "Unknown comparison decision."}
	}
	payload := events.CompareDecidedPayload{ID: id, Decision: decision, By: humanID}
	if winner != nil {
		payload.WinnerLane, payload.WinnerRun = winner.LaneID, winner.ID
	}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.CompareDecided, Actor: events.Human(humanID), ChannelID: channelID, Payload: payload, IdempotencyKey: "compare:" + id}); err != nil {
		return api.CompareGroup{}, err
	}
	group.Decision, group.WinnerLane = decision, payload.WinnerLane
	return *group, nil
}

// combineInputs returns the compare persona and the prompt context holding
// both diffs, or the reason a combined run cannot start.
func (a *App) combineInputs(ctx context.Context, group api.CompareGroup) (domain.Member, string, error) {
	parts := make([]string, 2)
	for i, candidate := range group.Candidates {
		if candidate.Run == nil {
			return domain.Member{}, "", errors.New("candidate run missing")
		}
		b, err := os.ReadFile(filepath.Join(a.Paths.RunsDir, candidate.Run.ID, "diff.patch"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return domain.Member{}, "", err
		}
		if len(b) > 128<<10 {
			return domain.Member{}, "", domain.UserError{Message: "A candidate diff is over 128 KB; combine it manually."}
		}
		if len(b) == 0 {
			return domain.Member{}, "", domain.UserError{Message: "Both candidates need a diff before they can be combined."}
		}
		parts[i] = fmt.Sprintf("Candidate %c on %s:\n%s", 'A'+i, candidate.LaneID, b)
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return domain.Member{}, "", err
	}
	var agent domain.Member
	for _, member := range members {
		if member.ID == group.AgentID {
			agent = member
			break
		}
	}
	if agent.Agent == nil {
		return domain.Member{}, "", errors.New("compare agent no longer exists")
	}
	if agent.Agent.Mode != domain.RunWrite {
		return domain.Member{}, "", domain.UserError{Message: "The compare persona is no longer a write persona."}
	}
	channel, err := a.Store.Channel(ctx, group.ChannelID)
	if err != nil {
		return domain.Member{}, "", err
	}
	projects, err := a.Store.Projects(ctx)
	if err != nil {
		return domain.Member{}, "", err
	}
	if project, ok := org.ProjectOfChannel(projects, channel.Name); ok && project.Archived {
		return domain.Member{}, "", domain.UserError{Message: "The project is archived, so the combined run did not start."}
	}
	departments, err := a.Store.Departments(ctx)
	if err != nil {
		return domain.Member{}, "", err
	}
	if allowed, _ := org.Gate(projects, departments, channel.Name, []domain.Member{agent}); len(allowed) == 0 {
		return domain.Member{}, "", domain.UserError{Message: "@" + agent.Handle + " is not assigned to this project's team."}
	}
	if _, skipped, err := a.Registry.Pick(agent.Handle, ""); err != nil && !lanes.Busy(skipped) {
		return domain.Member{}, "", domain.UserError{Message: "No healthy lane is available for the combined run."}
	}
	return agent, strings.Join(parts, "\n\n"), nil
}

// combineCompare discards both candidates and starts the combiner run for a
// combine decision that is already recorded. Every step can be repeated: the
// message has a fixed id and key, and the run starts only when none is tied
// to that message yet.
func (a *App) combineCompare(ctx context.Context, group api.CompareGroup, humanID, messageID string) error {
	agent, diffs, err := a.combineInputs(ctx, group)
	if err != nil {
		return err
	}
	for _, candidate := range group.Candidates {
		if err := a.discardCompareRun(ctx, candidate.Run); err != nil {
			return err
		}
	}
	m := domain.Message{ID: messageID, ChannelID: group.ChannelID, AuthorID: humanID, Body: "@" + agent.Handle + " Combine candidates A and B from comparison " + group.ID + " into one change. Take the best of each; review both diffs below.", CreatedAt: time.Now().UTC()}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(humanID), ChannelID: m.ChannelID, Payload: m, IdempotencyKey: "compare-combine:" + group.ID}); err != nil {
		return err
	}
	runs, err := a.Store.Runs(ctx, group.ChannelID, "")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.TriggerMessageID == messageID {
			return nil
		}
	}
	a.extraMu.Lock()
	if _, starting := a.extra[m.ID]; starting {
		a.extraMu.Unlock()
		return nil
	}
	if a.extra == nil {
		a.extra = map[string]string{}
	}
	a.extra[m.ID] = diffs
	a.extraMu.Unlock()
	go func() {
		defer a.clearExtra(m.ID)
		if a.compareDispatch != nil {
			if err := a.compareDispatch(context.Background(), m, agent, ""); err != nil {
				a.notice(context.Background(), m.ChannelID, "error", err.Error())
			}
		} else {
			a.run(context.Background(), m, agent, "")
		}
	}()
	return nil
}

func (a *App) discardCompareRun(ctx context.Context, run *domain.Run) error {
	if run == nil || run.ApprovalOption == "discard" || run.Worktree == "" {
		return nil
	}
	if _, err := os.Stat(run.Worktree); err == nil && run.State == domain.RunWaitingApproval {
		approval := domain.Approval{RunID: run.ID, ChannelID: run.ChannelID}
		_, err := a.ResolveApproval(ctx, approval, "discard", "")
		return err
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	channel, err := a.Store.Channel(ctx, run.ChannelID)
	if err != nil {
		return err
	}
	wm := worktree.Manager{BaseDir: a.Paths.WorktreesDir}
	if _, err := git(ctx, channel.RepoPath, "show-ref", "--verify", "--quiet", "refs/heads/fz/"+run.ID); err == nil {
		w, err := wm.Open(ctx, channel.RepoPath, run.Worktree, "fz/"+run.ID, run.BaseCommit)
		if err != nil {
			return err
		}
		if err := wm.Cleanup(ctx, w); err != nil {
			return err
		}
	}
	if run.State == domain.RunWaitingApproval {
		run.State = domain.RunDone
	}
	run.Worktree, run.BaseCommit, run.ApprovalOption = "", "", "discard"
	_, err = a.Store.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: run.ChannelID, Payload: *run})
	return err
}
