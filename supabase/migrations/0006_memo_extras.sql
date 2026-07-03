-- Render-time extras (chart URL, research links, sources, key stats) stored
-- at send so the memo can be re-rendered later (PDF export, web view).
alter table memos add column extras jsonb not null default '{}';
