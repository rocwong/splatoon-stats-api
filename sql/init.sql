CREATE ROLE readonly PASSWORD 'readonly';
REVOKE CREATE ON SCHEMA public FROM public;
GRANT CREATE ON SCHEMA public TO postgres;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM readonly;
ALTER ROLE "readonly" WITH LOGIN;
