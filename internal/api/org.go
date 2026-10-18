package api

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

// orgView is the body of GET /api/v1/org.
type orgView struct {
	DirectorID  string              `json:"director_id"`
	Departments []domain.Department `json:"departments"`
	Projects    []domain.Project    `json:"projects"`
}

func (a *API) org(w http.ResponseWriter, r *http.Request) {
	departments, projects, err := a.orgData(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, orgView{DirectorID: a.HumanID, Departments: departments, Projects: projects})
}

func (a *API) orgData(ctx context.Context) ([]domain.Department, []domain.Project, error) {
	departments, err := a.Store.Departments(ctx)
	if err != nil {
		return nil, nil, err
	}
	projects, err := a.Store.Projects(ctx)
	return departments, projects, err
}

// assignment edits one list of a project. kind is "department" or "specialist".
func (a *API) assignment(w http.ResponseWriter, r *http.Request, kind, handle string, add bool) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can change assignments")
		return
	}
	a.orgMu.Lock()
	defer a.orgMu.Unlock()
	p, err := a.Store.Project(r.Context(), r.PathValue("project"))
	if err != nil {
		failErr(w, err)
		return
	}
	var list *[]string
	switch kind {
	case "department":
		list = &p.Departments
	case "specialist":
		list = &p.Specialists
	default:
		fail(w, 400, "bad_request", "kind must be department or specialist")
		return
	}
	if add {
		known, err := a.knownHandle(r.Context(), kind, handle)
		if err != nil {
			failErr(w, err)
			return
		}
		if !known {
			fail(w, 400, "bad_request", "unknown "+kind+" "+handle)
			return
		}
		if !containsFold(*list, handle) {
			*list = append(*list, handle)
		}
	} else {
		*list = slices.DeleteFunc(*list, func(h string) bool { return strings.EqualFold(h, handle) })
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.ProjectUpdated, "", "", p); ok {
		respond(w, 200, p)
	}
}

// projectHandle matches the handles lanes.toml accepts.
var projectHandle = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// projectBody is what POST /api/v1/projects and PATCH /api/v1/projects/{project}
// accept. A nil field is left as it is.
type projectBody struct {
	Handle      string    `json:"handle"`
	Name        *string   `json:"name"`
	RepoPath    *string   `json:"repo_path"`
	Lead        *string   `json:"lead"`
	Channels    *[]string `json:"channels"`
	Departments *[]string `json:"departments"`
	Specialists *[]string `json:"specialists"`
	Archived    *bool     `json:"archived"`
}

// applyProject copies the body onto p and checks every handle it names. The
// returned message is empty when the project is valid.
func (a *API) applyProject(ctx context.Context, p *domain.Project, v projectBody, others []domain.Project) (string, error) {
	if v.Name != nil {
		p.Name = strings.TrimSpace(*v.Name)
		if p.Name == "" {
			return "name is required", nil
		}
	}
	if v.RepoPath != nil {
		p.RepoPath = strings.TrimSpace(*v.RepoPath)
	}
	if v.Lead != nil {
		p.Lead = strings.TrimSpace(*v.Lead)
	}
	if v.Channels != nil {
		p.Channels = dedupeFold(*v.Channels)
	}
	if v.Departments != nil {
		p.Departments = dedupeFold(*v.Departments)
	}
	if v.Specialists != nil {
		p.Specialists = dedupeFold(*v.Specialists)
	}
	if v.Archived != nil {
		p.Archived = *v.Archived
	}
	if p.Name == "" {
		p.Name = p.Handle
	}
	if p.Lead != "" {
		known, err := a.knownHandle(ctx, "specialist", p.Lead)
		if err != nil {
			return "", err
		}
		if !known {
			return "unknown lead " + p.Lead, nil
		}
	}
	for _, h := range p.Departments {
		known, err := a.knownHandle(ctx, "department", h)
		if err != nil {
			return "", err
		}
		if !known {
			return "unknown department " + h, nil
		}
	}
	for _, h := range p.Specialists {
		known, err := a.knownHandle(ctx, "specialist", h)
		if err != nil {
			return "", err
		}
		if !known {
			return "unknown specialist " + h, nil
		}
	}
	for _, name := range p.Channels {
		if !channelName.MatchString(name) {
			return "invalid channel name " + name, nil
		}
		for _, other := range others {
			if !strings.EqualFold(other.Handle, p.Handle) && containsFold(other.Channels, name) {
				return fmt.Sprintf("channel %s already belongs to project %s", name, other.Handle), nil
			}
		}
	}
	if err := validateRepo(ctx, p.RepoPath); err != nil {
		return err.Error(), nil
	}
	return "", nil
}

func dedupeFold(list []string) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s != "" && !containsFold(out, s) {
			out = append(out, s)
		}
	}
	return out
}

// createProject records a new project. Only a human may create one, and the
// handle must be new. It is stored in the org projection like a project from
// lanes.toml, so it survives a restart; a project that is also in lanes.toml
// takes its name, repository, lead and channels from the file on each start.
func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can create a project")
		return
	}
	var v projectBody
	if !decode(w, r, &v) {
		return
	}
	v.Handle = strings.TrimSpace(v.Handle)
	if !projectHandle.MatchString(v.Handle) {
		fail(w, 400, "bad_request", "handle: use letters, digits, - and _")
		return
	}
	a.orgMu.Lock()
	defer a.orgMu.Unlock()
	projects, err := a.Store.Projects(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	if slices.ContainsFunc(projects, func(p domain.Project) bool { return strings.EqualFold(p.Handle, v.Handle) }) {
		fail(w, 409, "conflict", "a project with handle "+v.Handle+" exists")
		return
	}
	p := domain.Project{Handle: v.Handle, Channels: []string{}, Departments: []string{}, Specialists: []string{}}
	msg, err := a.applyProject(r.Context(), &p, v, projects)
	if err != nil {
		failErr(w, err)
		return
	}
	if msg != "" {
		fail(w, 400, "bad_request", msg)
		return
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.ProjectUpdated, "", "", p); ok {
		respond(w, 201, p)
	}
}

// patchProject changes a project's name, repository, lead or channels.
// Assignments change through the assignments endpoints.
func (a *API) patchProject(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can change a project")
		return
	}
	var v projectBody
	if !decode(w, r, &v) {
		return
	}
	v.Departments, v.Specialists = nil, nil
	a.orgMu.Lock()
	defer a.orgMu.Unlock()
	p, err := a.Store.Project(r.Context(), r.PathValue("project"))
	if err != nil {
		failErr(w, err)
		return
	}
	projects, err := a.Store.Projects(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	msg, err := a.applyProject(r.Context(), &p, v, projects)
	if err != nil {
		failErr(w, err)
		return
	}
	if msg != "" {
		fail(w, 400, "bad_request", msg)
		return
	}
	if _, ok := a.append(w, r, events.Human(current(r).ID), events.ProjectUpdated, "", "", p); ok {
		respond(w, 200, p)
	}
}

func (a *API) knownHandle(ctx context.Context, kind, handle string) (bool, error) {
	if kind == "department" {
		departments, err := a.Store.Departments(ctx)
		if err != nil {
			return false, err
		}
		return slices.ContainsFunc(departments, func(d domain.Department) bool { return strings.EqualFold(d.Handle, handle) }), nil
	}
	members, err := a.Store.Members(ctx)
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(members, func(m domain.Member) bool {
		return m.Kind == domain.MemberAgent && strings.EqualFold(m.Handle, handle)
	}), nil
}

func (a *API) assign(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Kind   string `json:"kind"`
		Handle string `json:"handle"`
	}
	if !decode(w, r, &v) {
		return
	}
	a.assignment(w, r, v.Kind, v.Handle, true)
}

func (a *API) unassign(w http.ResponseWriter, r *http.Request) {
	a.assignment(w, r, r.PathValue("kind"), r.PathValue("handle"), false)
}

func containsFold(list []string, s string) bool { return org.ContainsFold(list, s) }

// chiefOfStaff finds the Chief of Staff for a channel that opted in. A direct
// channel never does: a message there is for the agent in it.
func (a *API) chiefOfStaff(c domain.Channel, members []domain.Member) (domain.Member, bool) {
	if a.Chief == nil || c.Kind == domain.ChannelDirect || c.Visibility == domain.VisibilityDirect {
		return domain.Member{}, false
	}
	handle, ok := a.Chief(c.Name)
	if !ok {
		return domain.Member{}, false
	}
	for _, m := range members {
		if m.Kind == domain.MemberAgent && strings.EqualFold(m.Handle, handle) {
			return m, true
		}
	}
	return domain.Member{}, false
}

// groupLeads turns @<department> into that department's lead and @<project>
// into the project lead. A group with no lead is reported in problems.
func groupLeads(body string, departments []domain.Department, projects []domain.Project, members []domain.Member) (leads []domain.Member, problems []string) {
	agent := func(handle string) (domain.Member, bool) {
		for _, m := range members {
			if m.Kind == domain.MemberAgent && strings.EqualFold(m.Handle, handle) {
				return m, true
			}
		}
		return domain.Member{}, false
	}
	for _, h := range mentionHandles(body) {
		lead, name := "", ""
		for _, d := range departments {
			if strings.EqualFold(d.Handle, h) {
				lead, name = d.Lead, d.DisplayName
			}
		}
		for _, p := range projects {
			if strings.EqualFold(p.Handle, h) {
				if p.Archived {
					problems = append(problems, fmt.Sprintf("@%s is archived, so its lead did not run.", p.Handle))
					name, lead = "", ""
				} else {
					lead, name = p.Lead, p.Name
				}
			}
		}
		if name == "" {
			continue
		}
		if m, ok := agent(lead); ok {
			leads = append(leads, m)
		} else {
			problems = append(problems, fmt.Sprintf("@%s has no lead, so nobody was asked.", h))
		}
	}
	return leads, problems
}
