-- `users` has no RLS (auth reads it before a user is known), so the RLS-bound app role must not
-- be able to read it: otherwise any query run inside withUser() could list every user's email.
-- (The initial blanket GRANT in 9999_rls_and_fts.sql covered it.) Foreign-key checks run as the
-- table owner, so user-owned tables can still reference users.
revoke all on users from aimanager_app;
revoke all on sessions from aimanager_app;
revoke all on pairing_requests from aimanager_app;
