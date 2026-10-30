-- Immutable observations; validation and refinement requests are separate append-only events.
CREATE TABLE refinement_evidence (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE refinement_claims (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE refinement_outcomes (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE refinement_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE refinement_reviews (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,id)
);
CREATE FUNCTION refinement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REFINEMENT_IMMUTABLE';
END;
$$;
CREATE TRIGGER refinement_evidence_immutable BEFORE UPDATE OR DELETE ON refinement_evidence FOR EACH ROW EXECUTE FUNCTION refinement_immutable();
CREATE TRIGGER refinement_claims_immutable BEFORE UPDATE OR DELETE ON refinement_claims FOR EACH ROW EXECUTE FUNCTION refinement_immutable();
CREATE TRIGGER refinement_outcomes_immutable BEFORE UPDATE OR DELETE ON refinement_outcomes FOR EACH ROW EXECUTE FUNCTION refinement_immutable();
CREATE TRIGGER refinement_requests_immutable BEFORE UPDATE OR DELETE ON refinement_requests FOR EACH ROW EXECUTE FUNCTION refinement_immutable();
CREATE TRIGGER refinement_reviews_immutable BEFORE UPDATE OR DELETE ON refinement_reviews FOR EACH ROW EXECUTE FUNCTION refinement_immutable();
