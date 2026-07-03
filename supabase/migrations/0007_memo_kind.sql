-- 'idea' = a new pick; 'followup' = an update note on previously covered name.
alter table memos add column kind text not null default 'idea';
