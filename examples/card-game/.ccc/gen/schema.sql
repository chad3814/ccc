-- auth
create table users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  salt text not null
);

create table sessions (
  token text primary key,
  user_id text not null references users (id)
);

-- leaderboard-store
create table leaderboard (
  user_id text primary key,
  wins integer not null
);

-- game-store
create table games (
  id text primary key,
  state jsonb not null
);
