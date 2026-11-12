-- Devices: a person's Mac app or Chrome extension, connected over the real-time
-- socket. While one is online, agents working for that person get its tools
-- (computer_* for a Mac, browser_* for Chrome). Each tool call becomes a
-- request the device answers; a grant records that the person let a run use
-- the device, so it's asked once per task (or never, with autopilot on).
create table if not exists devices (
    id            text primary key,
    user_id       text not null references users(id) on delete cascade,
    kind          text not null check (kind in ('mac', 'chrome')),
    name          text not null,
    capabilities  jsonb not null default '[]'::jsonb,
    online        boolean not null default false,
    connection_id text,
    node_id       text,
    autopilot     boolean not null default false,
    last_seen_at  bigint not null,
    created_at    bigint not null,
    updated_at    bigint not null
);
create index if not exists devices_owner on devices(user_id, online);

create table if not exists device_requests (
    id           text primary key,
    device_id    text not null references devices(id) on delete cascade,
    user_id      text not null references users(id) on delete cascade,
    run_id       text,
    step_id      text,
    tool         text not null,
    args         jsonb not null default '{}'::jsonb,
    status       text not null default 'pending' check (status in ('pending', 'done', 'failed', 'expired', 'cancelled')),
    result       jsonb,
    created_at   bigint not null,
    answered_at  bigint
);
create index if not exists device_requests_pending on device_requests(device_id, status, created_at);

create table if not exists device_grants (
    run_id     text not null references runs(id) on delete cascade,
    device_id  text not null references devices(id) on delete cascade,
    granted_by text not null references users(id) on delete cascade,
    granted_at bigint not null,
    primary key (run_id, device_id)
);

-- Captain and Researcher may use a person's Mac and Chrome from now on; other
-- agents can be given these in Settings → Agents.
update agents set tools = tools || '{use_computer,use_browser}'::text[]
where builtin and handle in ('captain', 'researcher') and not (tools @> '{use_computer}'::text[]);
