import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "../state/keys";
import type { Approval, Channel, Member, Org, Routine, Run } from "../types";
import { ProjectHome } from "./project-home";

const ada: Member = {
  id: "h1",
  kind: "human",
  handle: "ada",
  display_name: "Ada",
  presence: "online",
};
const agent = (handle: string, name: string): Member => ({
  id: `id-${handle}`,
  kind: "agent",
  handle,
  display_name: name,
  presence: "idle",
  agent: { lanes: ["codex/default"] },
});
const architect = agent("architect", "Architect");
const coder = agent("coder", "Coder");
const writer = agent("writer", "Writer");

const channel = (
  id: string,
  name: string,
  unread = 0,
  last_seq = 0,
): Channel => ({
  id,
  name,
  kind: "team",
  visibility: "public",
  member_ids: [],
  unread,
  last_seq,
});

const org: Org = {
  director_id: ada.id,
  departments: [
    {
      handle: "eng",
      display_name: "Engineering",
      lead: "coder",
      members: ["coder"],
    },
  ],
  projects: [
    {
      handle: "faztudo",
      name: "Faztudo",
      lead: "architect",
      channels: ["dev", "Release"],
      departments: ["eng"],
      specialists: ["writer"],
    },
    {
      handle: "other",
      name: "Other",
      channels: ["elsewhere", "ghost"],
      departments: [],
      specialists: [],
    },
  ],
};

const run = (
  id: string,
  state: Run["state"],
  channel_id: string,
  over: Partial<Run> = {},
): Run => ({
  id,
  channel_id,
  trigger_message_id: "m",
  agent_id: coder.id,
  lane_id: "codex/default",
  mode: "write",
  state,
  ...over,
});

const approval: Approval = {
  id: "ap1",
  run_id: "r-wait",
  channel_id: "c1",
  requested_by: coder.id,
  title: "Merge the login fix",
  detail: "",
  options: [],
  state: "pending",
};

const routine: Routine = {
  handle: "debrief",
  name: "Daily debrief",
  prompt: "p",
  persona: "writer",
  channel: "release",
  schedule: "0 9 * * *",
  enabled: true,
};

async function renderHome(handle = "faztudo") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(qk.org, org);
  client.setQueryData(qk.members, [ada, architect, coder, writer]);
  client.setQueryData(qk.channels, [
    channel("c1", "dev", 2, 9),
    channel("c2", "release", 0, 3),
    channel("c3", "elsewhere", 5, 20),
  ]);
  client.setQueryData(qk.approvals, [
    approval,
    { ...approval, id: "ap2", channel_id: "c3" },
  ]);
  client.setQueryData(qk.runs, [
    run("r-live", "running", "c1", {
      started_at: new Date(Date.now() - 65_000).toISOString(),
    }),
    run("r-other", "running", "c3"),
    run("r-merged", "done", "c2", {
      diff_stat: { files: 3, insertions: 10, deletions: 2 },
      ended_at: new Date().toISOString(),
    }),
    run("r-failed", "failed", "c1", {
      failure_reason: "tests red",
      ended_at: new Date(Date.now() - 5_000).toISOString(),
    }),
    run("r-failed-elsewhere", "failed", "c3", {
      failure_reason: "elsewhere",
      ended_at: new Date().toISOString(),
    }),
  ]);
  client.setQueryData(qk.tasks, [
    {
      id: "t1",
      channel_id: "c1",
      title: "Fix the login",
      assignee: "coder",
      mode: "write",
      scope: [],
      checks: [],
      acceptance: [],
      status: "running",
      order: 1,
      run_ids: [],
      created_by: "h1",
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:00:00Z",
    },
    {
      id: "t2",
      channel_id: "c2",
      title: "Write release notes",
      assignee: "writer",
      mode: "write",
      scope: [],
      checks: [],
      acceptance: [],
      status: "todo",
      order: 1,
      run_ids: [],
      created_by: "h1",
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:00:00Z",
    },
    {
      id: "t3",
      channel_id: "c1",
      title: "Old chore",
      assignee: "coder",
      mode: "read",
      scope: [],
      checks: [],
      acceptance: [],
      status: "done",
      order: 1,
      run_ids: [],
      created_by: "h1",
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:00:00Z",
    },
    {
      id: "t4",
      channel_id: "c3",
      title: "Other project task",
      assignee: "coder",
      mode: "read",
      scope: [],
      checks: [],
      acceptance: [],
      status: "todo",
      order: 1,
      run_ids: [],
      created_by: "h1",
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:00:00Z",
    },
  ]);
  client.setQueryData(qk.routines, [
    routine,
    {
      ...routine,
      handle: "x",
      name: "Elsewhere routine",
      channel: "elsewhere",
    },
  ]);
  const rootRoute = createRootRoute({
    component: () => <ProjectHome handle={handle} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ProjectHome", () => {
  it("shows the project's channels and not those of another project", async () => {
    await renderHome();
    const channels = await screen.findByRole("region", { name: "Channels" });
    expect(
      within(channels)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["#dev2", "#release"]);
    expect(screen.queryByText("elsewhere")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Faztudo",
    );
    expect(
      screen.getAllByRole("button", { name: "New channel" }).length,
    ).toBeGreaterThan(0);
  });

  it("lists what needs me, the live runs and the activity of this project only", async () => {
    await renderHome();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getAllByRole("link")).toHaveLength(1);
    expect(needs).toHaveTextContent("Merge the login fix");
    const active = screen.getByRole("region", { name: "Active runs" });
    expect(within(active).getAllByRole("link")).toHaveLength(1);
    expect(active).toHaveTextContent("Coder is working.");
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getAllByRole("listitem")).toHaveLength(2);
    expect(activity).toHaveTextContent("Coder merged in #release");
    expect(activity).toHaveTextContent("+10 -2 in 3");
    expect(activity).toHaveTextContent("Coder failed in #dev: tests red");
    expect(activity).not.toHaveTextContent("elsewhere");
  });

  it("lists the team with the lead first and the routines that post here", async () => {
    await renderHome();
    const team = await screen.findByRole("region", { name: "Team" });
    expect(
      within(team)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-agent")),
    ).toEqual(["architect", "coder", "writer"]);
    expect(team).toHaveTextContent("Lead");
    const routines = screen.getByRole("region", { name: "Routines" });
    expect(routines).toHaveTextContent("Daily debrief");
    expect(routines).not.toHaveTextContent("Elsewhere routine");
  });

  it("lists channels the project names that nobody created yet, with a way to create them", async () => {
    await renderHome("other");
    const channels = await screen.findByRole("region", { name: "Channels" });
    expect(
      within(channels)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["#elsewhere5"]);
    const ghost = within(channels)
      .getByText("ghost")
      .closest("li") as HTMLElement;
    expect(ghost).toHaveTextContent("Listed, not created");
    expect(
      within(ghost).getByRole("button", { name: "Create" }),
    ).toBeInTheDocument();
  });

  it("teaches what to do next when a section is empty", async () => {
    await renderHome("other");
    expect(
      await screen.findByText(/Nobody is assigned yet/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Assign" })[0]).toHaveAttribute(
      "href",
      "/organization",
    );
  });

  it("lists the open tasks of this project and links to the board", async () => {
    await renderHome();
    const tasks = await screen.findByRole("region", { name: "Tasks" });
    expect(tasks).toHaveTextContent("Fix the login");
    expect(tasks).toHaveTextContent("Write release notes");
    expect(tasks).not.toHaveTextContent("Old chore");
    expect(tasks).not.toHaveTextContent("Other project task");
    expect(
      within(tasks).getByRole("link", { name: "Open the board" }),
    ).toBeInTheDocument();
  });

  it("says so when the project does not exist", async () => {
    await renderHome("nope");
    expect(await screen.findByText("Project not found.")).toBeInTheDocument();
  });
});
