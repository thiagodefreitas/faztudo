package api

import (
	"context"
	"fmt"
	"net/http"
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
	if _, ok := a.append(w, r, events.ProjectUpdated, "", "", p); ok {
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
				lead, name = p.Lead, p.Name
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
