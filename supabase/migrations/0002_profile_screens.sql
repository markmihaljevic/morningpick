-- Derived FMP screen parameters per subscriber, recomputed when the profile
-- version changes (screens_version tracks which profile version they match).
alter table preference_profiles
  add column screens jsonb not null default '[]',
  add column screens_version int not null default -1;
